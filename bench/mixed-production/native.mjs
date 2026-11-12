// Native HTTP form transport. The browser parses captured app markup; it never renders
// expectedPage/referenceHtml. Scripts are off, preserving each app's ordinary no-JS path.
import { performance } from "node:perf_hooks";
import { snapshotPage } from "../marketplace/check.mjs";
import { sha256, sleep } from "./capture.mjs";

const publicHeaders = ["content-type", "content-encoding", "cache-control", "vary", "content-security-policy", "x-content-type-options"];
export function localURL(value, base) {
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin || url.username || url.password || url.hash) throw new Error("nonlocal native URL");
  return url;
}
export function nativeForm() {
  const forms = [...document.querySelectorAll(".marketplace__alert form")];
  if (forms.length !== 1 || forms[0].method !== "post") return null;
  const form = forms[0];
  const data = [...new FormData(form).entries()];
  if (data.some(([, value]) => typeof value !== "string")) return null;
  const submitters = [...form.querySelectorAll('button[type="submit"],input[type="submit"],button:not([type])')];
  if (submitters.length !== 1 || submitters[0].disabled) return null;
  const submitter = submitters[0];
  if (submitter.name) data.push([submitter.name, submitter.value]);
  return { action: submitter.hasAttribute("formaction") ? submitter.formAction : form.action,
    method: submitter.hasAttribute("formmethod") ? submitter.formMethod : form.method,
    contentType: submitter.hasAttribute("formenctype") ? submitter.formEnctype : form.enctype, data };
}
export function redactedDocument() {
  const root = document.documentElement.cloneNode(true);
  const secrets = new Set();
  const redact = (el, name) => {
    const value = el.getAttribute(name);
    if (value?.length >= 8) secrets.add(value);
    el.setAttribute(name, "[redacted]");
  };
  root.querySelectorAll("script,style,template,noscript").forEach((el) => {
    (el.content ?? el).replaceChildren(document.createTextNode("[redacted native inert content]"));
  });
  root.querySelectorAll("input,meta,option").forEach((el) => {
    for (const attr of ["value", "content"]) if (el.hasAttribute(attr)) redact(el, attr);
  });
  root.querySelectorAll("textarea").forEach((el) => { el.textContent = "[redacted]"; });
  const comments = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT), remove = [];
  while (comments.nextNode()) remove.push(comments.currentNode);
  remove.forEach((node) => node.remove());
  const semantic = /^(?:class|id|lang|dir|title|role|aria-[a-z-]+|data-listing-id|data-offer-id|name|type|method|enctype|for|placeholder|required|disabled|checked|selected|multiple|hidden|tabindex|rel|media|width|height|alt|action|formaction|href|src)$/;
  for (const el of [root, ...root.querySelectorAll("*")]) for (const attr of [...el.attributes]) {
    if (!semantic.test(attr.name) || /nonce|token|csrf|^on/i.test(attr.name)) redact(el, attr.name);
    if (["action", "formaction", "href", "src"].includes(attr.name)) {
      try {
        const url = new URL(attr.value, location.href);
        for (const key of [...url.searchParams.keys()]) if (!["seller", "sort", "offers"].includes(key)) {
          for (const value of url.searchParams.getAll(key)) if (value.length >= 8) secrets.add(value);
          url.searchParams.set(key, "[redacted]");
        }
        el.setAttribute(attr.name, url.pathname + url.search);
      } catch { el.setAttribute(attr.name, "[redacted]"); }
    }
  }
  let html = "<!DOCTYPE html>\n" + root.outerHTML;
  for (const value of secrets) html = html.replaceAll(value, "[redacted]");
  return html;
}

export async function nativeTransport({ browser, base, readbackPath, settings }) {
  const contexts = new Map();
  const contextFor = async (request) => {
    const key = `${request.source}:${request.client}`;
    if (!contexts.has(key)) contexts.set(key, await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" }));
    return contexts.get(key);
  };
  async function fetchNative(context, url, options = {}) {
    const start = performance.now();
    try {
      const response = await context.request.fetch(localURL(url, base).href, { timeout: settings.requestTimeoutMs, maxRedirects: 0, ...options });
      const body = await response.body();
      const headers = response.headers();
      const result = { status: response.status(), contentType: headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? null,
        contentEncoding: headers["content-encoding"] ?? "identity", error: null, headers: Object.fromEntries(publicHeaders.filter((h) => headers[h] !== undefined).map((h) => [h, headers[h]])),
        body, url: response.url(), location: headers.location, elapsedMs: performance.now() - start };
      await response.dispose();
      return result;
    } catch (error) {
      return { status: 0, contentType: null, contentEncoding: null, error: /Timeout|timed out/i.test(error.message) ? "timeout" : "network-error", body: Buffer.alloc(0), elapsedMs: performance.now() - start };
    }
  }
  // Raw bodies stay in memory. Save their hash/decoded size and a redacted native DOM, never
  // session cookies, token-bearing URLs, hidden fields or arbitrary native error pages.
  const receipt = (response, stage) => ({ stage, status: response.status, contentType: response.contentType, contentEncoding: response.contentEncoding,
    error: response.error, elapsedMs: response.elapsedMs, decodedBodyBytes: response.body.length, decodedBodySha256: sha256(response.body),
    headers: Object.fromEntries(Object.entries(response.headers ?? {}).filter(([name]) => name !== "content-security-policy")) });
  async function parse(context, response, request, callback) {
    const page = await context.newPage();
    try {
      const url = localURL(response.url ?? request.formPage ?? request.path, base).href;
      // Fulfill exactly this already fetched native document. Do not refetch a primary read.
      await page.route("**/*", async (route) => {
        if (route.request().isNavigationRequest() && route.request().url() === url) {
          await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: response.body });
        } else if (route.request().resourceType() === "stylesheet" && new URL(route.request().url()).origin === new URL(base).origin) {
          await route.continue();
        } else await route.abort();
      });
      await page.goto(url, { waitUntil: "load", timeout: settings.requestTimeoutMs });
      return await callback(page);
    } finally { await page.close(); }
  }
  return {
    async discover(request, evidence) {
      const context = await contextFor(request);
      const response = await fetchNative(context, request.formPage, { headers: { accept: "text/html", "accept-encoding": request.acceptEncoding } });
      evidence.stages.push(receipt(response, "form-discovery"));
      if (response.status !== 200 || response.contentType !== "text/html") return null;
      const form = await parse(context, response, request, (page) => page.evaluate(nativeForm));
      if (!form || form.method !== "post") return null;
      const action = localURL(form.action, base);
      return { client: request.client, source: request.source, locale: request.locale, itemId: request.itemId, method: "POST", action: action.pathname,
        contentType: form.contentType, fields: form.data.map(([name]) => name), transport: { context, url: action.href, data: form.data } };
    },
    async readState(request, evidence, stage) {
      if (!readbackPath) return null;
      const context = await contextFor(request);
      const response = await fetchNative(context, localURL(readbackPath, base).href, { headers: { accept: "application/json", "cache-control": "no-cache" } });
      evidence.stages.push(receipt(response, `state-${stage}`));
      if (response.status !== 200 || response.contentType !== "application/json") return null;
      try {
        const alerts = JSON.parse(response.body.toString("utf8"));
        if (!Array.isArray(alerts) || alerts.some((a) => !a || Object.keys(a).sort().join(",") !== "email,item_id,target_minor"
          || typeof a.email !== "string" || typeof a.item_id !== "string" || !Number.isSafeInteger(a.target_minor) || a.target_minor <= 0)) return null;
        return alerts;
      } catch { return null; }
    },
    async send(request, binding, evidence, injector) {
      const context = await contextFor(request);
      const headers = { accept: request.accept, "accept-encoding": request.acceptEncoding };
      let url = request.path, options = { method: request.method, headers };
      if (binding) {
        url = binding.transport.url;
        const data = binding.transport.data.map(([key, value]) => [key, Object.hasOwn(binding.input, key) ? binding.input[key] : value]);
        headers.origin = new URL(base).origin; headers.referer = localURL(request.formPage, base).href;
        if (binding.evidence.contentType === "application/x-www-form-urlencoded") {
          headers["content-type"] = binding.evidence.contentType; options.data = new URLSearchParams(data).toString();
        } else {
          const form = new FormData(); for (const [key, value] of data) form.append(key, value); options.multipart = form;
        }
      }
      let response;
      if (request.category === "slow" && request.variant === "cancel") {
        // Playwright request-context disposal can wait for an in-flight request. Explicitly
        // abort a real HTTP client, carrying this lane's native cookies, instead. Successful
        // early responses still fail the expected cancellation, rather than being relabeled.
        const abort = new AbortController(), start = performance.now();
        const cookies = await context.cookies(base);
        let reason = "timeout", settled = false;
        const timer = setTimeout(() => abort.abort(), settings.requestTimeoutMs);
        try {
          const pending = (async () => {
            try {
              const r = await fetch(localURL(url, base), { method: "GET", headers: { ...headers,
                ...(cookies.length ? { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } : {}) }, redirect: "manual", signal: abort.signal });
              const body = Buffer.from(await r.arrayBuffer());
              return { status: r.status, error: null, contentType: r.headers.get("content-type")?.split(";")[0].trim() ?? null,
                contentEncoding: r.headers.get("content-encoding") ?? "identity", headers: {}, body, url: r.url, elapsedMs: performance.now() - start };
            } catch {
              return { status: 0, error: abort.signal.aborted ? reason : "network-error", contentType: null, contentEncoding: null,
                headers: {}, body: Buffer.alloc(0), elapsedMs: performance.now() - start };
            } finally { settled = true; }
          })();
          const until = Date.now() + settings.requestTimeoutMs;
          let reached = false;
          while (!settled && Date.now() < until) {
            if ((await injector.read(request.id)).requests > 0) { reached = true; break; }
            await sleep(10);
          }
          if (reached && !settled) { await sleep(settings.cancelAfterMs); reason = "cancelled"; abort.abort(); }
          response = await pending;
          evidence.cancel = { upstreamObservedBeforeAbort: reached };
        } finally { clearTimeout(timer); }
      } else response = await fetchNative(context, url, options);
      evidence.stages.push(receipt(response, "primary"));
      if (binding && [302, 303].includes(response.status)) {
        let visible = response;
        for (let redirects = 0; redirects < 5 && [302, 303].includes(visible.status); redirects++) {
          visible = await fetchNative(context, localURL(visible.location, visible.url).href, { headers });
          evidence.stages.push(receipt(visible, "native-redirect"));
        }
        // Keep the primary status/headers in the contract, but extract the actual visible page.
        response.visible = visible;
      }
      return response;
    },
    async snapshot(response, request, evidence) {
      const visible = response.visible ?? response;
      if (visible.contentType !== "text/html" || ![200, 400, 422].includes(visible.status)) throw new Error("no visible native page");
      return parse(await contextFor(request), visible, request, async (page) => {
        evidence.redactedNativeDOM = await page.evaluate(redactedDocument);
        return page.evaluate(snapshotPage);
      });
    },
    async close() { for (const context of contexts.values()) await context.close(); contexts.clear(); },
  };
}
