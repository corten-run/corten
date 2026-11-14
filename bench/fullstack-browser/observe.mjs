import { randomUUID } from "node:crypto";
import { publicURL, publicInput, sha256, transportOf } from "./contract.mjs";
import { snapshotPage } from "../marketplace/check.mjs";
import { intentionalDisabledPreload, isScriptPreload } from "../catalog/check.mjs";
import { discoverReactEndpoint } from "./bindings.mjs";
import { observeBindingLinks } from "./binding-links.mjs";
import { inspectScopedBinding } from "./scopes.mjs";
import { singleFetchData } from "./navigation.mjs";
import { NativeNetworkAudit, responseDateHash } from "./cancellations.mjs";
import { performance } from "node:perf_hooks";
import { installResourceObserver } from "./resources.mjs";
import { collectBrowserDOM } from "./native-browser-dom.mjs";
import { retainBrowserDOMProjection } from "./native-responses.mjs";

export async function observedContext(browser, options, observation, role) {
  if (!observation) return browser.newContext(options);
  const row = { id: randomUUID(), role, app: observation.app, case: observation.case, source: observation.source,
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    createStartedAt: Date.now(), createdAt: null, closeStartedAt: null, closeEventAt: null, closeCompletedAt: null, absentAfter: null };
  observation.contexts.push(row);
  const context = await browser.newContext(options); row.createdAt = Date.now();
  observation.byContext.set(context, row); observation.byRequest.set(context.request, row);
  context.on("close", () => { row.closeEventAt = Date.now(); });
  return context;
}
export async function closeObservedContext(browser, context, observation) {
  const row = observation?.byContext.get(context);
  if (row) row.closeStartedAt = Date.now();
  await context.close();
  if (row) { row.closeCompletedAt = Date.now(); row.absentAfter = !browser.contexts().includes(context); }
}

export function classifyDisabledPreloads(rows, dom, javaScriptEnabled) {
  const document = rows.find((r) => r.resource === "document");
  const hasCsp = Boolean(document?.hasCsp || dom?.native?.hasMetaCsp);
  for (const r of rows) {
    const scriptPreload = dom?.native?.preloads?.some((p) => p.path === r.path && isScriptPreload(p)) ?? false;
    r.intentionallyDisabledPreload = intentionalDisabledPreload({ javaScriptEnabled, resourceType: r.resource, errorText: r.failure, scriptPreload, hasCsp });
  }
}

// No headers, cookies, transport tokens, full POST bodies or raw HTML are saved.
export function observeNetwork(page) {
  const rows = [], pending = new Set(), byRequest = new Map(), byId = new Map(), bindings = new Map(), failures = [];
  const waiters = new Set();
  const notify = () => { for (const wake of waiters) wake(); waiters.clear(); };
  let formBinding = null;
  const track = (promise) => { pending.add(promise); promise.catch((e) => failures.push(e.message)).finally(() => pending.delete(promise)); };
  page.on("request", (request) => {
    const row = { id: randomUUID(), ...publicURL(request.url()), method: request.method(), transport: transportOf(request),
      resource: request.resourceType(), status: null, completed: false, input: null, components: [], failure: null, bytes: null, bodySha256: null, type: null, encoding: null, hasCsp: false };
    rows.push(row); byRequest.set(request, row); byId.set(row.id, request); bindings.set(request, formBinding);
    notify();
    track((async () => {
      let input = publicInput(request, formBinding);
      if (input === null) {
        const form = await new Response(request.postDataBuffer(), { headers: { "content-type": request.headers()["content-type"] } }).formData();
        input = { input: { email: form.get("email"), target_price: form.get("target_price") }, components: [] };
      }
      Object.assign(row, input);
    })());
  });
  page.on("requestfailed", (r) => { const row = byRequest.get(r); if (row) row.failure = r.failure()?.errorText ?? "request failed"; notify(); });
  page.on("response", (response) => {
    const row = byRequest.get(response.request());
    if (!row) return;
    row.status = response.status();
    const headers = response.headers(); row.type = headers["content-type"] ?? null; row.encoding = headers["content-encoding"] ?? "identity";
    row.hasCsp = Boolean(headers["content-security-policy"]);
    if (row.resource === "document") row.dateSha256 = responseDateHash(headers);
  });
  page.on("requestfinished", (request) => { track((async () => {
    const row = byRequest.get(request), response = await request.response();
    if (!row || !response) return;
    row.completed = true;
    const size = await request.sizes();
    // responseBodySize is the encoded body, not the decoded body. Header sizes
    // are Playwright's HTTP size estimate, not TLS/link-layer traffic.
    row.bytes = { encodedBody: size.responseBodySize, headers: size.responseHeadersSize, decodedBody: null };
    if (response.status() >= 300 && response.status() < 400) return;
    let body;
    try { body = await response.body(); }
    catch (error) { row.captureError = error.message; throw error; }
    row.bytes.decodedBody = body.length; row.bodySha256 = sha256(body);
    const form = bindings.get(request);
    if (form?.router?.basis === "mounted-react-router-Form" && row.resource === "fetch" && /^text\/x-script\b/.test(row.type ?? "")) {
      const data = singleFetchData(body, row.method);
      if (data) {
        row.nativeData = data;
        row.nativeProtocol = { framework: "react-router", transportAtDispatch: row.transport, form: structuredClone(form) };
        row.transport = "router";
      }
    }
    if (row.transport === "router" && /\/__data\.json$/.test(row.path) && /^application\/json\b/.test(row.type ?? "")) {
      try {
        const value = JSON.parse(body.toString("utf8"));
        if (value.type === "data" && Array.isArray(value.nodes)) row.nativeData = { framework: "sveltekit", type: value.type, nodes: value.nodes.map((node) => node?.type ?? null) };
      } catch { /* A malformed native payload is retained, never normalized. */ }
    }
  })().finally(notify)); });
  const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); await native?.drain(); };
  let native;
  return { rows, failures,
    requestId(request) { return byRequest.get(request)?.id ?? null; },
    attachCDP(cdp, lifecycle) { native = new NativeNetworkAudit(cdp, (id) => { const request = byId.get(id); return request ? { url: request.url(), startTime: request.timing().startTime } : null; },
      (receipt) => lifecycle?.events.push(receipt)); },
    annotate() { native?.annotate(rows); },
    originatingDocument(binding) {
      native?.annotate(rows);
      const matches = rows.filter((r) => binding && r.resource === "document" && r.nativeDocument?.frame === binding.frame && r.nativeDocument?.loader === binding.loader
        && r.completed && !r.failure && !r.captureError && r.bodySha256 && !(r.status >= 300 && r.status < 400));
      return matches.length === 1 ? { requestId: matches[0].id, sha256: matches[0].bodySha256 } : null;
    },
    bindForm(form) { formBinding = form ? structuredClone(form) : null; }, drain,
    async settle(offset, deadline, requirePost = false) {
      while (performance.now() < deadline) {
        const observed = rows.slice(offset);
        if ((!requirePost || observed.some((row) => row.method === "POST")) && observed.every((row) => row.completed || row.failure)) {
          await drain();
          if (rows.slice(offset).every((row) => row.completed || row.failure)) return;
        }
        await new Promise((resolve) => {
          const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
          const timer = setTimeout(wake, Math.max(0, deadline - performance.now())); waiters.add(wake);
        });
      }
      throw new Error("Native request completion not observed within the action deadline");
    } };
}

// Read native bindings, never install a common navigation/form implementation.
export function nativeDOM() {
  const article = document.querySelector("article.marketplace");
  const form = document.querySelector(".marketplace__alert form");
  const wire = article ? [...article.querySelectorAll("[wire\\:id]"), ...(article.hasAttribute("wire:id") ? [article] : [])] : [];
  const ancestor = article?.parentElement?.closest("[wire\\:id]");
  if (ancestor) wire.push(ancestor);
  const scriptPaths = [...document.scripts].map((s) => s.src ? new URL(s.src).pathname : null).filter(Boolean);
  const inline = [...document.scripts].map((s) => s.textContent).join("\n");
  const next = document.getElementById("__NEXT_DATA__");
  const nextPage = next ? JSON.parse(next.textContent).page : null;
  const turbo = typeof globalThis.Turbo !== "undefined" || /@hotwired\/turbo/.test(inline) || scriptPaths.some((s) => /turbo/.test(s));
  const turboDisabled = article?.closest("[data-turbo]")?.getAttribute("data-turbo") === "false";
  const updateURI = document.querySelector("script[data-update-uri]")?.getAttribute("data-update-uri");
  const updateURL = updateURI ? new URL(updateURI, document.baseURI) : null;
  const reactProps = form && Object.keys(form).find((key) => key.startsWith("__reactProps$"));
  const reactFiber = form && Object.keys(form).find((key) => key.startsWith("__reactFiber$"));
  let router = null;
  if (typeof form?.[reactProps]?.onSubmit === "function" && form.getAttribute("data-discover") === "true") {
    for (let node = form[reactFiber], index = 0; node && index++ < 32; node = node.return) {
      if (node.type?.displayName === "Form" && node.memoizedProps?.reloadDocument !== true && node.memoizedProps?.navigate !== false
        && node.memoizedProps?.method?.toLowerCase() === "post" && globalThis.__reactRouterContext && globalThis.__reactRouterManifest?.routes) {
        const path = new URL(form.action).pathname;
        router = { basis: "mounted-react-router-Form", wirePath: path + ".data", routes: Object.keys(globalThis.__reactRouterManifest.routes),
          handlerSource: Function.prototype.toString.call(form[reactProps].onSubmit), componentSource: Function.prototype.toString.call(node.type.render) };
        break;
      }
    }
  }
  return { scriptPaths, nextPage, turbo, turboDisabled, components: [...new Set(wire.map((el) => el.getAttribute("wire:id")))],
    hasMetaCsp: Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy" i]')),
    preloads: [...document.querySelectorAll("link[rel][href]")].map((el) => ({ rel: el.rel, as: el.as, path: new URL(el.href).pathname, sameOrigin: new URL(el.href).origin === location.origin })),
    assets: [...document.querySelectorAll('link[rel~="stylesheet"][href],img[src]')].map((el) => ({
      type: el.localName === "link" ? "Stylesheet" : "Image", path: new URL(el.localName === "link" ? el.href : el.currentSrc || el.src).pathname,
      sameOrigin: new URL(el.localName === "link" ? el.href : el.currentSrc || el.src).origin === location.origin })),
    markers: { corten: /"corten"\s*:/.test(inline), nuxt: Boolean(document.getElementById("__NUXT_DATA__")),
      reactRouter: /__reactRouter/.test(inline), sveltekit: /__sveltekit/.test(inline), astro: Boolean(document.querySelector('meta[name="generator"][content^="Astro"]')) || scriptPaths.some((s) => /^\/_astro\/ClientRouter\.astro_/.test(s)),
      tanstack: /\$TSR|__TSR|tsr-stream/.test(inline), leptos: scriptPaths.some((s) => /leptos|hydrate/.test(s)) || /\.wasm|wasm_bindgen/.test(inline) },
    form: form ? { method: form.method.toUpperCase(), action: new URL(form.action).pathname,
      fields: [...form.elements].map((el) => el.name).filter(Boolean),
      models: Object.fromEntries([...form.elements].filter((el) => ["email", "target_price"].includes(el.name)).map((el) => [el.name,
        [...el.attributes].find((a) => /^wire:model(?:\.|$)/.test(a.name))?.value ?? null])),
      component: form.closest("[wire\\:id]")?.getAttribute("wire:id") ?? null,
      router,
      binding: [...form.attributes].find((a) => a.name.startsWith("wire:submit"))?.name ?? (form.hasAttribute("data-patch") ? "data-patch" : null),
      turbo: form.closest("[data-turbo]")?.getAttribute("data-turbo") !== "false", encoding: form.enctype,
      updatePath: updateURL?.origin === location.origin ? updateURL.pathname : null } : null };
}
export async function nativeForm(page, native, app, js, cdp, inspect = true, bindingWindow = null) {
  const form = native.form;
  if (form && js && inspect && app === "nextjs") {
    const observed = await observeBindingLinks(cdp, ".marketplace__alert form", page.url(), bindingWindow);
    const diagnostics = [];
    form.enhancement = observed.outcome === "observed" ? discoverReactEndpoint([observed.candidate], observed.linked, diagnostics) : null;
    form.bindingObservation = { outcome: form.enhancement ? "proved" : "unknown", reason: form.enhancement ? null
      : observed.reason ?? diagnostics[0] ?? "Emitted component/native scope effects are unsupported" };
  }
  if (form && js && inspect && ["nuxt", "tanstack-start"].includes(app)) {
    const receipt = await inspectScopedBinding(cdp, app, page.url(), form.action);
    form.enhancement = receipt.binding; form.bindingObservation = { trace: receipt.trace, reason: receipt.reason };
  }
  if (form?.router) {
    sanitizeNative(native);
    if (js && app === "react-router") form.enhancement = { path: form.action, transport: "router", basis: form.router.basis };
  }
  return form;
}
export function sanitizeNative(native) {
  const router = native.form?.router;
  if (router) for (const name of ["handler", "component"]) {
    if (typeof router[`${name}Source`] === "string") router[`${name}Sha256`] = sha256(router[`${name}Source`]);
    delete router[`${name}Source`];
  }
  return native;
}
export function architecture(app, native) {
  if (app === "nextjs") return native.nextPage?.startsWith("/marketplace/") ? "next-pages" : "unverified-next-architecture";
  if (app === "laravel") return native.components.length && native.form?.binding?.startsWith("wire:submit") ? "livewire" : "blade";
  if (app === "rails") return native.turbo && !native.turboDisabled ? "hotwire" : "rails-controller";
  const marker = { "react-router": "reactRouter", "tanstack-start": "tanstack" }[app] ?? app;
  return native.markers[marker] ? app : `unverified-${app}-architecture`;
}
async function retainedDOM(page, observation, identity) {
  try {
    const readWindow = { startedAt: Date.now(), finishedAt: null };
    const dom = await collectBrowserDOM(page, identity);
    readWindow.finishedAt = Date.now();
    const expected = { observer: dom.observer, ...identity, readInterval: dom.readInterval, url: dom.url };
    const responseEvidence = retainBrowserDOMProjection(observation.store, dom, expected);
    return { ...expected, readWindow, responseEvidence, page: dom.result.page, error: dom.result.error?.text ?? null,
      articleCount: dom.result.articleCount, extractionComplete: dom.result.extractionComplete };
  } catch {
    // Collector argument/URL diagnostics may include the rejected private value.
    throw new Error("Typed native DOM extraction unavailable");
  }
}

export async function visibleDOM(page, observation = null, identity = null) {
  const native = sanitizeNative(await page.evaluate(nativeDOM));
  if (observation) {
    if (!identity?.originatingResponse || !identity.scope) return { observer: randomUUID(), scope: identity?.scope ?? null, url: publicURL(page.url()), native,
      page: null, error: null, responseEvidence: null, extractionComplete: false, captureFailure: "native-document-binding-unavailable" };
    return { ...await retainedDOM(page, observation, identity), native };
  }
  const present = await page.locator("article.marketplace").count();
  return { observer: randomUUID(), scope: await page.evaluate(() => globalThis.__fullstackBrowserAudit?.checkpoint()?.scope ?? null), url: publicURL(page.url()), native,
    page: present ? await page.evaluate(snapshotPage) : null,
    error: present ? null : (await page.locator("body").innerText()).trim() };
}
export async function responseDocument(browser, response, url, observation = null, requestId = null, action = null) {
  // Parse the actual initial response in a DIFFERENT, script-disabled context.
  // Fulfillment replays only these observed bytes to the parser, never oracle HTML.
  const body = await response.body();
  const context = await observedContext(browser, { javaScriptEnabled: false, serviceWorkers: "block" }, observation, "ssr-parser");
  try {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      if (route.request().isNavigationRequest() && route.request().url() === url) await route.fulfill({ status: response.status(), contentType: "text/html", body });
      else await route.abort();
    });
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await page.evaluate(installResourceObserver);
    const scope = await page.evaluate(() => globalThis.__fullstackBrowserAudit.checkpoint().scope);
    const result = { observer: randomUUID(), scope, url: publicURL(url), error: null,
      responseSha256: sha256(body), status: response.status(), page: observation ? null : await page.evaluate(snapshotPage), native: sanitizeNative(await page.evaluate(nativeDOM)),
      parserScope: "Independent script-disabled response parser; styles/resources blocked, not a second application render" };
    if (observation) {
      result.context = observation.byContext.get(context).id;
      result.requestId = requestId; result.responseEvidence = null;
      try {
        Object.assign(result, await retainedDOM(page, observation, { context: result.context, case: observation.case, action, scope,
          originatingResponse: { requestId, sha256: result.responseSha256 } }));
      } catch { result.captureFailure = "public-dom-projection-unproved"; }
    }
    return result;
  } finally { await closeObservedContext(browser, context, observation); }
}
