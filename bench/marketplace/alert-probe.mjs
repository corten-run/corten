// Focused regression probe for script-free marketplace alert forms (#1251). It repeats the
// gate's three alert-form cases in one locale on the gate's phone profile with JavaScript off,
// observes each submission with the gate's own submitAlert, then separately asserts the POST
// status, that nothing redirected, that the POST is the last main-frame document request through
// the final assertion (so a later GET cannot stand in for it), and the exact message.
// A functional check, never a throughput measurement. Run it in the checker's Playwright image.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { locales } from "./contract.mjs";
import { normalize } from "./records.mjs";
import { alertCases, comparePage, loadChromium, snapshotPage, submitAlert } from "./check.mjs";

// The gate's phone viewport and deadlines (check.mjs, checkApp).
export const profile = { javaScriptEnabled: false, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" };
const limit = 2048;
const kept = 10;

// Each diagnostic read has its own deadline, so an unfinished document cannot stall reporting.
async function bounded(read) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(read).catch((error) => `unavailable: ${error.message.split("\n", 1)[0]}`.slice(0, limit)),
      new Promise((resolve) => { timer = setTimeout(() => resolve("unavailable: diagnostic timeout"), 2000); })]);
  } finally { clearTimeout(timer); }
}
const tail = (value) => typeof value === "string" ? value.slice(-limit) : value;

async function failure(page, state, error) {
  const elapsedMs = Date.now() - state.started;
  // All reads run together, so the whole bundle takes at most one read deadline.
  const [posts, readyState, message, html] = await Promise.all([
    Promise.all(state.posts.map(async (request) => {
      const response = await bounded(() => request.response());
      const answered = typeof response === "object" && response !== null;
      return { url: request.url(), navigation: request.isNavigationRequest(), failure: request.failure()?.errorText ?? null,
        status: answered ? response.status() : response, redirectedTo: request.redirectedTo()?.url() ?? null,
        body: answered && !request.redirectedTo() ? tail(await bounded(() => response.text())) : null };
    })),
    bounded(() => page.evaluate(() => document.readyState)),
    bounded(() => page.locator(".marketplace__message").textContent({ timeout: 1000 })),
    bounded(() => page.evaluate(() => document.documentElement.outerHTML)),
  ]);
  // The main-frame document requests since the submission, in order (the first few, and how many in all).
  const documents = state.documents.map((request) => ({ method: request.method(), url: request.url(),
    redirectedFrom: request.redirectedFrom()?.url() ?? null }));
  const diagnostic = { case: state.case, elapsedMs, steps: state.steps, url: page.url(), postCount: state.postCount, posts,
    documentCount: state.submittedDocuments, documents, readyState, message,
    document: tail(html), error: tail(error.message), cause: tail(error.cause?.message ?? null) };
  const summary = { case: state.case, url: diagnostic.url, postCount: state.postCount, posts: posts.map(({ body, ...post }) => post),
    documentCount: state.submittedDocuments, documents, readyState, message };
  return Object.assign(new Error(`alert probe ${JSON.stringify(summary)}`, { cause: error }), { diagnostic });
}

// One case exactly as the gate submits it: a fresh GET of the page, then the native form POST.
export async function probeAlertCase(page, { base, locale, record, email, price, message }) {
  // Requests are counted, and only the first few kept, so a refresh loop that re-posts cannot grow without bound.
  const state = { case: { locale, id: record.id, email, price }, started: Date.now(), steps: {}, postCount: 0, posts: [],
    submitted: false, submittedDocuments: 0, documents: [], lastDocument: null };
  const onRequest = (request) => {
    if (request.method() === "POST" && ++state.postCount <= 5) state.posts.push(request);
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    state.lastDocument = request;
    if (state.submitted && ++state.submittedDocuments <= kept) state.documents.push(request);
  };
  page.on("request", onRequest);
  try {
    const visit = await page.goto(`${base}/marketplace/${locale}/${record.id}`, { waitUntil: "load" });
    assert.equal(visit.status(), 200, "page GET status");
    comparePage(await page.evaluate(snapshotPage), record, locale);
    state.steps.loaded = Date.now() - state.started;
    const form = page.locator(".marketplace__alert form");
    const action = await form.evaluate((f) => f.action);
    await form.locator('[name="email"]').fill(email); await form.locator('[name="target_price"]').fill(price);
    // HTML email validation would otherwise prevent the invalid-email server case.
    await form.evaluate((f) => { f.noValidate = true; });
    state.submitted = true;
    await submitAlert(page, form, false);
    state.steps.submitted = Date.now() - state.started;
    assert.equal(state.postCount, 1, "exactly one POST");
    const [post] = state.posts;
    assert.equal(post.url(), action, "POST targets the form action");
    assert.ok(post.isNavigationRequest(), "a script-free submission is a document POST");
    assert.equal(post.redirectedTo()?.url() ?? null, null, "the POST must not redirect");
    const response = await post.response();
    assert.equal(response?.status(), 200, "POST status");
    assert.equal(page.url(), action, "the resulting document is at the POST URL");
    // The same URL is not the same document: a POST answered with a refresh to a GET would pass that.
    // The last main-frame document request (or the request it was redirected from) must be the POST,
    // before the snapshot and still after the final assertion.
    const documents = state.submittedDocuments;
    const origin = (request) => { while (request.redirectedFrom()) request = request.redirectedFrom(); return request; };
    // Identity, not assert.equal: a failed deep comparison would render two whole Playwright objects.
    assert.ok(origin(state.lastDocument) === post, "the inspected document is the POST's response");
    const snapshot = await page.evaluate(snapshotPage);
    assert.equal(snapshot.message, normalize(message), "exact alert message");
    comparePage(snapshot, record, locale, { message });
    assert.equal(state.submittedDocuments, documents, "no document request started while the POST document was inspected");
    return { ms: Date.now() - state.started, ...state.steps };
  } catch (error) {
    throw await failure(page, state, error);
  } finally { page.off("request", onRequest); }
}

// Each iteration is one fresh browser context, like one gate profile, submitting all three cases in order.
// A deadline stops the probe between cases, so a stalled app still leaves its diagnostics within a budget.
export async function probeAlerts({ base, source, catalog, browser, iterations, locale = "en-US", deadline = Infinity }) {
  assert.ok(locales.includes(locale) && Number.isSafeInteger(iterations) && iterations > 0);
  const record = catalog.item_1;
  const cases = alertCases(locale, record).map(([email, price, message]) => ({ email, price, message, passed: 0, failed: 0, ms: { loaded: [], submitted: [], total: [] } }));
  const result = { probe: "marketplace alert form, JavaScript off, phone", source, locale, iterations, cases, failures: [] };
  for (let i = 0; i < iterations && !result.stopped; i++) {
    const context = await browser.newContext(profile);
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(20000);
    try {
      const page = await context.newPage();
      const errors = []; page.on("pageerror", (e) => errors.push(e.message));
      for (const entry of cases) {
        if (Date.now() > deadline) { result.stopped = { iteration: i, reason: "budget exhausted" }; break; }
        try {
          const { ms, loaded, submitted } = await probeAlertCase(page, { base, locale, record, ...entry });
          entry.passed++; entry.ms.loaded.push(loaded); entry.ms.submitted.push(submitted - loaded); entry.ms.total.push(ms);
        } catch (error) {
          entry.failed++;
          if (result.failures.length < kept) result.failures.push({ iteration: i, ...(error.diagnostic ?? { error: tail(error.stack ?? String(error)) }) });
        }
      }
      if (errors.length) result.failures.push({ iteration: i, pageErrors: errors.slice(0, 5).map(tail) });
    } finally { await context.close(); }
  }
  result.failures.splice(kept);
  // Elapsed milliseconds per passing case: to the loaded page, for the submission, and in total.
  const spread = (values) => { const v = values.toSorted((a, b) => a - b); return v.length ? { min: v[0], p50: v[Math.floor(v.length / 2)], max: v.at(-1) } : null; };
  for (const entry of cases) entry.ms = Object.fromEntries(Object.entries(entry.ms).map(([key, values]) => [key, spread(values)]));
  result.passed = !result.stopped && result.cases.every((entry) => entry.failed === 0) && result.failures.length === 0;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, source, iterations = "50", output, budget] = process.argv.slice(2);
  assert.ok(base && ["fixture", "api"].includes(source) && (budget === undefined || /^[1-9]\d*$/.test(budget)),
    "usage: node alert-probe.mjs BASE fixture|api [ITERATIONS] [OUTPUT] [BUDGET_SECONDS]");
  const deadline = budget === undefined ? Infinity : Date.now() + Number(budget) * 1000;
  const catalog = JSON.parse(readFileSync(new URL("./fixtures/marketplace.json", import.meta.url)));
  const browser = await (await loadChromium()).launch({ headless: true });
  let result;
  try { result = await probeAlerts({ base, source, catalog, browser, iterations: Number(iterations), deadline }); }
  finally { await browser.close(); }
  const value = JSON.stringify(result, null, 2);
  if (output) writeFileSync(output, value);
  console.log(value);
  process.exitCode = result.passed ? 0 : 1;
}