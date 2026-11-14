import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { snapshotPage } from "../marketplace/check.mjs";
import { definition } from "../workloads/registry.mjs";
import { encoded, exact, sha256 } from "./native-evidence.mjs";

// These fixed functions alone choose reads. Neither capture nor replay accepts
// a source, selector or function from the caller or saved observation.
function publicBrowserURL(value, base, page = false) {
  const url = new URL(value, base), entries = [...url.searchParams];
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash
    || new Set(entries.map(([key]) => key)).size !== entries.length
    || url.search && url.search !== `?${new URLSearchParams(entries)}`) throw Error("credential-filter-blocked");
  const route = /^\/marketplace\/(en-US|fr-FR|de-DE)\/(item_(?:[1-9]\d{0,2}|missing))$/.exec(url.pathname);
  if (page && !route || route && route[2] !== "item_missing" && Number(route[2].slice(5)) > 500) throw Error("credential-filter-blocked");
  if (entries.length && (!route || url.origin !== new URL(base).origin || entries.some(([key, val]) =>
    key === "seller" ? !["", "Alice"].includes(val) : key === "sort" ? !["asc", "desc"].includes(val) : key === "offers" ? val !== "all" : true))) throw Error("credential-filter-blocked");
  if (route?.[2] === "item_missing" && entries.length) throw Error("credential-filter-blocked");
  return { path: url.pathname, query: Object.fromEntries(entries) };
}
function missingSnapshot() {
  const articleCount = document.querySelectorAll("article.marketplace").length;
  if (articleCount !== 0) throw Error("native-dom-snapshot-failed");
  const matches = [];
  for (const el of document.querySelectorAll('h1,h2,p,[role="alert"]')) {
    const tag = el.publicMissingTag;
    if (tag === null) continue;
    // Collector exposes only a visible allowlisted phrase/tag, never arbitrary
    // tag names, ARIA/style strings or body innerText from an error document.
    const text = el.publicMissingText;
    if (text !== null) matches.push({ code: "not-found", text, tag });
  }
  if (!matches.length) throw Error("public-error-unavailable");
  return { kind: "missing-item", page: null, error: matches[0], articleCount, extractionComplete: true };
}
const errorTexts = ["Not found", "Not Found", "Page not found", "Item not found", "Record not found", "404", "404 Not Found", "404: Not Found", "This page could not be found."];
const methods = ["querySelector", "querySelectorAll", "matches", "getAttribute", "contains", "cloneNode", "remove"];
const properties = ["documentElement", "localName", "hidden", "textContent", "disabled", "readOnly", "htmlFor", "id", "name", "method", "action", "type", "inputMode", "options", "lang", "display", "visibility", "opacity", "pathname", "marketplaceInjected", "publicMissingTag", "publicMissingText"];
const snapshotSha256 = sha256(encoded([snapshotPage.toString(), missingSnapshot.toString(), publicBrowserURL.toString(), recordBrowserDOM.toString(), errorTexts]));
const cases = definition("fullstack-browser").cases.map((c) => c.key);
function identityFields(value) {
  for (const key of ["context", "scope"]) assert.match(value[key], /^[a-zA-Z0-9_.:-]{1,128}$/);
  assert.ok(cases.includes(value.case)); assert.match(value.action, new RegExp(`^${value.case}-([0-9]|10)$`));
  exact(value.originatingResponse, ["requestId", "sha256"]);
  assert.match(value.originatingResponse.requestId, /^[a-zA-Z0-9_.:-]{1,128}$/); assert.match(value.originatingResponse.sha256, /^[a-f0-9]{64}$/);
}
function expectedShape(value) {
  exact(value, ["observer", "context", "case", "action", "scope", "originatingResponse", "readInterval", "url"]); identityFields(value);
  assert.match(value.observer, /^[a-f0-9-]{36}$/);
  exact(value.readInterval, ["startedAt", "finishedAt"]);
  assert.ok(Number.isFinite(value.readInterval.startedAt) && Number.isFinite(value.readInterval.finishedAt)
    && value.readInterval.startedAt >= 0 && value.readInterval.finishedAt >= value.readInterval.startedAt && value.readInterval.finishedAt - value.readInterval.startedAt <= 15000);
  exact(value.url, ["path", "query"]);
  const url = new URL(value.url.path, "http://native.invalid");
  assert.equal(url.pathname, value.url.path);
  for (const [key, val] of Object.entries(value.url.query)) { assert.equal(typeof val, "string"); url.searchParams.append(key, val); }
  assert.deepEqual(publicBrowserURL(url.href, "http://native.invalid", true), value.url);
}
function unknown() { return { kind: null, page: null, error: null, articleCount: null, extractionComplete: false }; }

// Serialized only with the installed fixed snapshot factory and validators.
function recordBrowserDOM(identity, makeSnapshot, missing, publicURL, phrases) {
  let events = [], next = 0; const objects = new Map(), originals = new Map();
  const rootIds = { document: 0, location: 1, global: 2 }, empty = { kind: null, page: null, error: null, articleCount: null, extractionComplete: false };
  const fail = (reason) => ({ roots: rootIds, events: [], result: empty, failure: reason, scopeObservation: null, urlObservation: null });
  try {
    const scopeBefore = globalThis.__fullstackBrowserAudit?.checkpoint()?.scope ?? null;
    const urlBefore = publicURL(location.href, location.href, true);
    if (JSON.stringify(urlBefore) !== JSON.stringify(identity.url)) throw Error("native-scope-mismatch");
    if (scopeBefore !== identity.scope) throw Error("native-scope-mismatch");
    const visible = (el) => {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })
        || el.closest('[hidden],[aria-hidden="true"]')) return false;
      // checkVisibility does not check an element's own skipped contents.
      // Only the fixed visible policy is supported, including on ancestors.
      let members = 0;
      for (let at = el; at; at = at.parentElement) {
        if (++members > 10000) throw Error("native-dom-snapshot-failed");
        if (getComputedStyle(at).contentVisibility !== "visible") return false;
      }
      return true;
    };
    const secrets = new Set(); let privateBytes = 0;
    const privateValue = (value) => {
      if (value === undefined || value === null || value === "") return;
      if (typeof value !== "string" || value.length > 131072 || (privateBytes += value.length * 2) > 32 * 1024 ** 2) throw Error("credential-filter-blocked");
      secrets.add(value);
    };
    // Inventory actual private native fields before recording anything. Never
    // return these values, source names, or a diagnostic containing them.
    const privateRoots = [document]; let privateMembers = 0;
    for (let root = 0; root < privateRoots.length; root++) {
      const privateSources = privateRoots[root].querySelectorAll("input,textarea,select,meta,template");
      if ((privateMembers += privateSources.length) > 10000) throw Error("credential-filter-blocked");
      for (const el of privateSources) {
        if (el.localName === "template") {
          if (!(el instanceof HTMLTemplateElement) || !(el.content instanceof DocumentFragment)) throw Error("credential-filter-blocked");
          privateRoots.push(el.content);
        } else if (el.localName === "meta") {
          if (el.childNodes.length) throw Error("credential-filter-blocked");
          privateValue(el.getAttribute("value")); privateValue(el.content);
        } else {
          if (el.localName === "input" && el.type === "file" && el.files?.length) throw Error("credential-filter-blocked");
          // Inert template controls are private even if their own style appears visible.
          if (root === 0 && el.type !== "hidden" && el.type !== "password" && visible(el)) continue;
          privateValue(el.getAttribute("value")); privateValue(el.value); privateValue(el.defaultValue);
          if (el.localName === "select") {
            if ((privateMembers += el.options.length) > 10000) throw Error("credential-filter-blocked");
            for (const option of el.options) privateValue(option.value);
          }
        }
      }
    }
    const urls = ["action", "formaction", "href", "src", "data-src"];
    for (const el of document.querySelectorAll("[action],[formaction],[href],[src],[data-src]")) for (const key of urls) {
      if (el.hasAttribute(key)) publicURL(el.getAttribute(key), location.href);
    }
    const safe = (value, key) => {
      if (typeof value === "string") {
        if (value.length > 131072 || [...secrets].some((secret) => value.includes(secret))) throw Error("credential-filter-blocked");
        if (urls.includes(key)) publicURL(value, location.href);
      }
      return value;
    };
    const idFor = (value) => { if (!objects.has(value)) objects.set(value, next++); return objects.get(value); };
    const encode = (value, key) => {
      if (value === undefined) return { undefined: true };
      if (value === null || ["string", "boolean", "number"].includes(typeof value)) return { scalar: safe(value, key) };
      if (Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection) {
        if (value.length > 10000) throw Error("native-dom-snapshot-failed"); return { list: [...value].map((v) => encode(v)) };
      }
      return { object: idFor(value) };
    };
    const arg = (value) => originals.has(value) ? { object: idFor(originals.get(value)) } : encode(value);
    const decode = (value) => "scalar" in value ? value.scalar : value.undefined ? undefined : value.list ? value.list.map(decode) : wrap([...objects].find(([, id]) => id === value.object)[0]);
    const push = (e) => { if (events.length >= 30000) throw Error("native-dom-snapshot-failed"); events.push(e); };
    const wrap = (target) => {
      const proxy = new Proxy({}, { get(_unused, key) {
        if (typeof key !== "string") throw Error("native-dom-snapshot-failed");
        if (["querySelector", "querySelectorAll", "matches", "getAttribute", "contains", "cloneNode", "remove"].includes(key)) return (...args) => {
          if (key === "getAttribute" && !["aria-hidden", "role", "data-src", "aria-label", "data-listing-id", "data-offer-id", "href"].includes(args[0])) throw Error("native-dom-snapshot-failed");
          const value = target[key](...args.map((v) => originals.get(v) ?? v));
          if (key === "getAttribute" && args[0] === "aria-hidden" && value !== null && !["true", "false"].includes(value)) throw Error("credential-filter-blocked");
          const result = encode(value, key === "getAttribute" ? args[0] : key);
          push({ target: idFor(target), kind: "call", key, args: args.map(arg), result }); return decode(result);
        };
        if (!["documentElement", "localName", "hidden", "textContent", "disabled", "readOnly", "htmlFor", "id", "name", "method", "action", "type", "inputMode", "options", "lang", "display", "visibility", "opacity", "pathname", "marketplaceInjected", "publicMissingTag", "publicMissingText"].includes(key)) throw Error("native-dom-snapshot-failed");
        let value;
        if (key === "publicMissingTag") value = ["h1", "h2", "p", "div", "section", "span"].includes(target.localName) ? target.localName : null;
        else if (key === "publicMissingText") {
          const descendants = target.querySelectorAll("*");
          if (descendants.length > 10000) throw Error("native-dom-snapshot-failed");
          if (!visible(target) || [...descendants].some((el) => !visible(el))
            || target.querySelector('input[type="hidden"],input[type="password"],meta,script,style,template,[hidden],[aria-hidden="true"]')
            || target.textContent.length > 256) value = null;
          else { const text = target.textContent.replace(/[\t\n\r\f ]+/g, " ").trim(); value = phrases.includes(text) ? safe(text, key) : null; }
        } else {
          if (key === "textContent" && (target.matches('input[type="hidden"],input[type="password"],meta,script,style,template,[hidden],[aria-hidden="true"]')
            || target.querySelector('input[type="hidden"],input[type="password"],meta,script,style,template,[hidden],[aria-hidden="true"]'))) throw Error("credential-filter-blocked");
          value = target[key];
        }
        const result = encode(value, key); push({ target: idFor(target), kind: "get", key, args: [], result }); return decode(result);
      } }); originals.set(proxy, target); return proxy;
    };
    const roots = { document: idFor(document), location: idFor(location), global: idFor(globalThis) };
    const styles = (el) => { const target = originals.get(el), result = encode(getComputedStyle(target));
      push({ target: null, kind: "style", key: "getComputedStyle", args: [{ object: idFor(target) }], result }); return decode(result); };
    const snapshot = makeSnapshot(wrap(document), wrap(location), wrap(globalThis), styles, URL);
    const missingRead = missing(wrap(document), styles);
    const result = urlBefore.path.endsWith("/item_missing") ? missingRead()
      : { kind: "page", page: snapshot(), error: null, articleCount: 1, extractionComplete: true };
    const scopeAfter = globalThis.__fullstackBrowserAudit?.checkpoint()?.scope ?? null, urlAfter = publicURL(location.href, location.href, true);
    if (scopeAfter !== scopeBefore || JSON.stringify(urlAfter) !== JSON.stringify(urlBefore)) throw Error("native-scope-mismatch");
    return { roots, events, result, failure: null, scopeObservation: { before: scopeBefore, after: scopeAfter }, urlObservation: { before: urlBefore, after: urlAfter } };
  } catch (error) { return fail(["credential-filter-blocked", "public-error-unavailable", "native-scope-mismatch"].includes(error.message) ? error.message : "native-dom-snapshot-failed"); }
}

/** No caller-selected code: this function composes only installed fixed sources. */
export async function collectBrowserDOM(page, identity) {
  exact(identity, ["context", "case", "action", "scope", "originatingResponse"]); identityFields(identity);
  const observer = randomUUID(), startedAt = Date.now();
  // Reject secret/unknown current URL without returning that URL in a receipt.
  const url = publicBrowserURL(page.url(), page.url(), true);
  const collect = new Function("identity", `return (${recordBrowserDOM.toString()})(identity,
    (document,location,globalThis,getComputedStyle,URL)=>(${snapshotPage.toString()}),
    (document,getComputedStyle)=>(${missingSnapshot.toString()}),
    ${publicBrowserURL.toString()},${JSON.stringify(errorTexts)});`);
  const transcript = await page.evaluate(collect, { ...identity, url });
  const observation = { schema: "native-browser-dom-observation/v1", observer, ...identity,
    readInterval: { startedAt, finishedAt: Date.now() }, url, snapshotSha256, ...transcript };
  assert.ok(encoded(observation).length <= 32 * 1024 ** 2);
  expectedShape({ observer, ...identity, readInterval: observation.readInterval, url });
  return observation;
}

export function replayBrowserDOM(observation, expectedIdentity) {
  expectedShape(expectedIdentity);
  exact(observation, ["schema", ...Object.keys(expectedIdentity), "snapshotSha256", "roots", "events", "result", "failure", "scopeObservation", "urlObservation"]);
  assert.equal(observation.schema, "native-browser-dom-observation/v1"); assert.equal(observation.snapshotSha256, snapshotSha256);
  for (const key of Object.keys(expectedIdentity)) assert.deepEqual(observation[key], expectedIdentity[key]);
  assert.ok(encoded(observation).length <= 32 * 1024 ** 2);
  assert.deepEqual(observation.roots, { document: 0, location: 1, global: 2 });
  assert.ok(Array.isArray(observation.events) && observation.events.length <= 30000);
  if (observation.failure !== null) {
    assert.ok(["credential-filter-blocked", "public-error-unavailable", "native-scope-mismatch", "native-dom-snapshot-failed"].includes(observation.failure));
    assert.deepEqual(observation.events, []); assert.deepEqual(observation.result, unknown());
    assert.equal(observation.scopeObservation, null); assert.equal(observation.urlObservation, null); return unknown();
  }
  assert.deepEqual(observation.scopeObservation, { before: observation.scope, after: observation.scope });
  assert.deepEqual(observation.urlObservation, { before: observation.url, after: observation.url });
  const refs = new Map(); let at = 0;
  const encode = (v) => refs.has(v) ? { object: refs.get(v) } : v === undefined ? { undefined: true } : { scalar: v };
  const decode = (v, depth = 0) => {
    assert.ok(depth < 32 && v && Object.keys(v).length === 1);
    if ("scalar" in v) { assert.ok(v.scalar === null || ["string", "number", "boolean"].includes(typeof v.scalar));
      if (typeof v.scalar === "string") assert.ok(v.scalar.length <= 131072); if (typeof v.scalar === "number") assert.ok(Number.isFinite(v.scalar)); return v.scalar; }
    if ("undefined" in v) { assert.equal(v.undefined, true); return undefined; }
    if ("list" in v) { assert.ok(Array.isArray(v.list) && v.list.length <= 10000); return v.list.map((x) => decode(x, depth + 1)); }
    assert.ok(Number.isSafeInteger(v.object) && v.object >= 0 && v.object < 30000); return wrap(v.object);
  };
  const call = (target, kind, key, args) => {
    const e = observation.events[at++]; assert.ok(e); exact(e, ["target", "kind", "key", "args", "result"]);
    assert.deepEqual([e.target, e.kind, e.key, e.args], [target, kind, key, args.map(encode)]);
    if (key === "getAttribute" && args[0] === "aria-hidden") assert.ok([null, "true", "false"].includes(e.result.scalar));
    if (key === "publicMissingText") assert.ok(e.result.scalar === null || errorTexts.includes(e.result.scalar));
    if (key === "publicMissingTag") assert.ok(e.result.scalar === null || ["h1", "h2", "p", "div", "section", "span"].includes(e.result.scalar));
    return decode(e.result);
  };
  const wrap = (id) => {
    const proxy = new Proxy({}, { get(_unused, key) {
      assert.equal(typeof key, "string");
      if (methods.includes(key)) return (...args) => call(id, "call", key, args);
      assert.ok(properties.includes(key)); return call(id, "get", key, []);
    } }); refs.set(proxy, id); return proxy;
  };
  const bindings = { document: wrap(0), location: wrap(1), globalThis: wrap(2), URL,
    getComputedStyle: (el) => call(null, "style", "getComputedStyle", [el]) };
  const missing = observation.url.path.endsWith("/item_missing");
  const value = runInNewContext(`(${(missing ? missingSnapshot : snapshotPage).toString()})()`, bindings,
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  const result = missing ? JSON.parse(JSON.stringify(value)) : { kind: "page", page: JSON.parse(JSON.stringify(value)), error: null, articleCount: 1, extractionComplete: true };
  assert.equal(at, observation.events.length, "unused browser DOM read"); assert.deepEqual(result, observation.result); return result;
}
