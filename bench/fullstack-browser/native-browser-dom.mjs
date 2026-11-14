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
const snapshotSha256 = sha256(encoded([snapshotPage.toString(), missingSnapshot.toString(), publicBrowserURL.toString(), recordBrowserDOM.toString(),
  nativeNodeRecords.toString(), startNativeMutations.toString(), finishNativeMutations.toString(), clearNativeMutations.toString(),
  readNativeBoundary.toString(), replayNativeBoundary.toString(), collectBrowserDOM.toString(), replayBrowserDOM.toString(), errorTexts]));
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
    const publicOffersField = (el) => {
      if (!(el instanceof HTMLInputElement) || el.type !== "hidden" || el.name !== "offers" || urlBefore.query.offers !== "all"
        || el.value !== "all" || el.defaultValue !== "all" || el.getAttribute("value") !== "all"
        || el.getAttributeNames().sort().join(",") !== "name,type,value") return false;
      const forms = document.querySelectorAll("main article.marketplace .marketplace__listings form"), form = el.form;
      if (forms.length !== 1 || form !== forms[0] || el.parentElement !== form || form.method !== "get"
        || form.querySelectorAll('[name="offers"]').length !== 1) return false;
      const action = publicURL(form.action, location.href, true);
      return new URL(form.action).origin === location.origin && action.path === urlBefore.path && Object.keys(action.query).length === 0;
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
          if (root === 0 && publicOffersField(el)) continue;
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

// Native descriptors alone classify closed/UA roots and template fragments.
// Raw protocol attributes, names, text and URLs never enter these records.
function nativeNodeRecords(raw, frameId) {
  const queue = [...raw], records = [];
  for (let at = 0; at < queue.length; at++) {
    assert.ok(queue.length <= 10000);
    const n = queue[at];
    assert.ok(!n.contentDocument && (!n.frameId || n.frameId === frameId && (n.nodeType === 9 || n.nodeType === 1 && n.localName === "html")) && !n.importedDocument
      && !["frame", "iframe", "object", "embed"].includes(n.localName));
    const shadowRoots = (n.shadowRoots ?? []).map((r) => {
      assert.equal(r.shadowRootType, "user-agent");
      return { nodeId: r.nodeId, backendNodeId: r.backendNodeId, type: r.shadowRootType };
    });
    records.push({ nodeId: n.nodeId, backendNodeId: n.backendNodeId, nodeType: n.nodeType,
      kind: n.templateContent ? "template" : n.frameId && n.nodeType === 1 ? "document-element" : "ordinary", childNodeCount: n.childNodeCount ?? 0,
      children: n.children ? n.children.map((c) => c.nodeId) : n.childNodeCount ? null : [],
      templateContent: n.templateContent?.nodeId ?? null, shadowRoots });
    queue.push(...n.children ?? []); if (n.templateContent) queue.push(n.templateContent);
  }
  return records;
}

function startNativeMutations(observer) {
  if (globalThis.__cortenNativeDOMBoundary) throw Error("native-dom-snapshot-failed");
  const roots = [document], state = { observer, document, roots, changed: false };
  state.watch = new MutationObserver(() => { state.changed = true; });
  globalThis.__cortenNativeDOMBoundary = state;
  for (let i = 0; i < roots.length; i++) {
    if (roots.length > 10000) throw Error("native-dom-snapshot-failed");
    state.watch.observe(roots[i], { subtree: true, childList: true, attributes: true, characterData: true });
    for (const t of roots[i].querySelectorAll("template")) {
      if (!(t instanceof HTMLTemplateElement)) throw Error("native-dom-snapshot-failed");
      roots.push(t.content);
    }
  }
  return { observer, roots: roots.length };
}

function finishNativeMutations(observer) {
  const state = globalThis.__cortenNativeDOMBoundary;
  if (!state || state.observer !== observer || this !== document || this !== state.document
    || state.changed || state.watch.takeRecords().length) throw Error("native-dom-snapshot-failed");
  return { observer, roots: state.roots.length, mutations: [] };
}

function clearNativeMutations(observer) {
  const state = globalThis.__cortenNativeDOMBoundary;
  if (!state || state.observer !== observer || this !== document || this !== state.document) throw Error("native-dom-snapshot-failed");
  state.watch.disconnect(); delete globalThis.__cortenNativeDOMBoundary;
  return { observer };
}

async function readNativeBoundary(page, identity, collect, observer, startedAt) {
  const failed = () => ({ roots: { document: 0, location: 1, global: 2 }, events: [], result: unknown(),
    failure: "native-dom-snapshot-failed", scopeObservation: null, urlObservation: null, boundaryObservation: null });
  let session, opening, closing = false, teardownUntil, candidate = failed(), changed = false, pending = null, bytes = 0, frameId, world, ownedDocument, watching = false;
  const commands = [], nodes = new Map(), ids = new Set(), backends = new Set();
  const limit = 15000, readUntil = startedAt + limit, detachments = new WeakMap();
  const within = async (operation, until) => {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("native-dom-snapshot-failed")), Math.max(0, until - Date.now())); })]); }
    finally { clearTimeout(timer); }
  };
  const budget = (operation) => { assert.ok(Date.now() < readUntil); return within(operation(), readUntil); };
  const detach = (active, until) => {
    // Invoke even when no wait remains; keep the actual acknowledgement consumed.
    if (!detachments.has(active)) detachments.set(active, Promise.resolve().then(() => active.detach()));
    return within(detachments.get(active), until);
  };
  const disposalUntil = () => Date.now() < teardownUntil ? teardownUntil : Date.now() + limit;
  const check = () => { assert.equal(changed, false); assert.ok(Date.now() - startedAt <= 15000); };
  const measure = (raw) => {
    // This transient size check is never written to evidence or diagnostics.
    assert.ok((bytes += Buffer.byteLength(JSON.stringify(raw))) <= 32 * 1024 ** 2);
    return raw;
  };
  const consume = (raw) => {
    measure(raw);
    const records = nativeNodeRecords(raw, frameId);
    for (const n of records) {
      for (const member of [n, ...n.shadowRoots]) {
        assert.ok(Number.isSafeInteger(member.nodeId) && member.nodeId > 0 && !ids.has(member.nodeId)); ids.add(member.nodeId);
        assert.ok(Number.isSafeInteger(member.backendNodeId) && member.backendNodeId > 0 && !backends.has(member.backendNodeId)); backends.add(member.backendNodeId);
      }
      assert.ok(ids.size <= 10000); nodes.set(n.nodeId, structuredClone(n));
    }
    return records;
  };
  const clearOwned = async (active, until) => {
    const send = (method, params = {}) => { assert.ok(Date.now() < until); return within(active.send(method, params), until); };
    const { frameTree } = measure(await send("Page.getFrameTree"));
    assert.deepEqual([frameTree.frame.id, frameTree.frame.loaderId], [ownedDocument.frameId, ownedDocument.loaderId]);
    const { root } = measure(await send("DOM.getDocument", { depth: 0, pierce: false }));
    assert.equal(root.nodeType, 9); assert.equal(root.backendNodeId, ownedDocument.backendNodeId);
    const isolated = await send("Page.createIsolatedWorld", { frameId, worldName: "corten-native-dom-boundary" });
    assert.equal(isolated.executionContextId, world);
    const resolved = await send("DOM.resolveNode", { backendNodeId: ownedDocument.backendNodeId, executionContextId: world, objectGroup: observer });
    assert.equal(resolved.object.type, "object"); assert.equal(typeof resolved.object.objectId, "string");
    const cleared = await send("Runtime.callFunctionOn", { objectId: resolved.object.objectId, functionDeclaration: clearNativeMutations.toString(),
      arguments: [{ value: observer }], returnByValue: true });
    assert.ok(!cleared.exceptionDetails); assert.deepEqual(cleared.result.value, { observer });
    await send("Runtime.releaseObjectGroup", { objectGroup: observer }); await send("DOM.disable"); watching = false;
  };
  try {
    // Ownership is installed before the raced wait, including a late original attach.
    opening = Promise.resolve().then(() => page.context().newCDPSession(page)).then(async (active) => {
      session = active;
      if (closing) await detach(active, disposalUntil());
      return active;
    });
    session = await budget(() => opening); check();
    const send = (method, params = {}) => budget(() => session.send(method, params));
    await send("DOM.enable"); commands.push({ method: "DOM.enable" });
    const invalidate = () => { changed = true; };
    for (const event of ["attributeModified", "attributeRemoved", "characterDataModified", "childNodeCountUpdated", "childNodeInserted", "childNodeRemoved",
      "documentUpdated", "shadowRootPushed", "shadowRootPopped", "distributedNodesUpdated", "pseudoElementAdded", "pseudoElementRemoved"]) session.on(`DOM.${event}`, invalidate);
    session.on("DOM.setChildNodes", ({ parentId, nodes: raw }) => {
      try {
        assert.ok(pending && pending.nodeId === parentId && pending.reply === null);
        const parent = nodes.get(parentId); assert.equal(parent.children, null); assert.equal(raw.length, parent.childNodeCount);
        const records = consume(raw); parent.children = raw.map((n) => n.nodeId);
        pending.reply = { method: "DOM.requestChildNodes", nodeId: parentId, children: [...parent.children], nodes: records };
      } catch { changed = true; }
    });
    const { frameTree } = await send("Page.getFrameTree"); check(); assert.ok(!frameTree.childFrames?.length); frameId = frameTree.frame.id;
    const loaderId = frameTree.frame.loaderId;
    assert.match(loaderId, /^[a-zA-Z0-9_.:-]{1,128}$/);
    commands.push({ method: "Page.getFrameTree", frameId, loaderId, childFrames: [] });
    const { root: originalDocument } = measure(await send("DOM.getDocument", { depth: 0, pierce: false })); check();
    assert.equal(originalDocument.nodeType, 9); assert.ok(Number.isSafeInteger(originalDocument.backendNodeId) && originalDocument.backendNodeId > 0);
    ownedDocument = { backendNodeId: originalDocument.backendNodeId, frameId, loaderId };
    commands.push({ method: "DOM.getDocument", role: "observer-document", ...ownedDocument });
    const isolated = await send("Page.createIsolatedWorld", { frameId, worldName: "corten-native-dom-boundary" }); check(); world = isolated.executionContextId;
    commands.push({ method: "Page.createIsolatedWorld", frameId, executionContextId: world });
    watching = true;
    const started = await send("Runtime.callFunctionOn", { executionContextId: world, functionDeclaration: startNativeMutations.toString(),
      arguments: [{ value: observer }], returnByValue: true, awaitPromise: false }); check();
    assert.ok(!started.exceptionDetails && started.result.value);
    commands.push({ method: "Runtime.callFunctionOn", role: "mutation-start", executionContextId: world, result: started.result.value });
    const { root } = await send("DOM.getDocument", { depth: 1, pierce: false }); check();
    assert.equal(root.backendNodeId, ownedDocument.backendNodeId);
    const document = { nodeId: root.nodeId, backendNodeId: root.backendNodeId, frameId, loaderId };
    commands.push({ method: "DOM.getDocument", root: root.nodeId, nodes: consume([root]) });
    for (const n of nodes.values()) if (n.children === null) {
      check(); pending = { nodeId: n.nodeId, reply: null };
      await send("DOM.requestChildNodes", { nodeId: n.nodeId, depth: 1, pierce: false }); check();
      assert.ok(pending.reply); commands.push(pending.reply); pending = null;
    }
    const resolved = await send("DOM.resolveNode", { nodeId: root.nodeId, objectGroup: observer }); check();
    assert.equal(resolved.object.type, "object"); assert.equal(typeof resolved.object.objectId, "string");
    commands.push({ method: "DOM.resolveNode", role: "semantic-read", ...document });
    const read = await send("Runtime.callFunctionOn", { objectId: resolved.object.objectId, functionDeclaration: collect.toString(),
      arguments: [{ value: identity }], returnByValue: true, awaitPromise: false }); check();
    assert.ok(!read.exceptionDetails && read.result.value);
    commands.push({ method: "Runtime.callFunctionOn", role: "semantic-read", ...document, observer });
    const barrier = await send("DOM.describeNode", { nodeId: root.nodeId, depth: 0, pierce: false }); check();
    assert.equal(barrier.node.nodeId, root.nodeId); assert.equal(barrier.node.backendNodeId, root.backendNodeId);
    commands.push({ method: "DOM.describeNode", ...document });
    const isolatedDocument = await send("DOM.resolveNode", { nodeId: root.nodeId, executionContextId: world, objectGroup: observer }); check();
    assert.equal(typeof isolatedDocument.object.objectId, "string");
    commands.push({ method: "DOM.resolveNode", role: "mutation-check", ...document, executionContextId: world });
    const unchanged = await send("Runtime.callFunctionOn", { objectId: isolatedDocument.object.objectId, functionDeclaration: finishNativeMutations.toString(),
      arguments: [{ value: observer }], returnByValue: true, awaitPromise: false }); check();
    assert.ok(!unchanged.exceptionDetails && unchanged.result.value);
    commands.push({ method: "Runtime.callFunctionOn", role: "mutation-check", ...document, executionContextId: world, result: unchanged.result.value });
    const cleared = await send("Runtime.callFunctionOn", { objectId: isolatedDocument.object.objectId, functionDeclaration: clearNativeMutations.toString(), arguments: [{ value: observer }], returnByValue: true }); check();
    assert.ok(!cleared.exceptionDetails); assert.deepEqual(cleared.result.value, { observer }); watching = false;
    commands.push({ method: "Runtime.callFunctionOn", role: "mutation-cleanup", ...document, executionContextId: world, observer, result: cleared.result.value });
    await send("Runtime.releaseObjectGroup", { objectGroup: observer }); check(); commands.push({ method: "Runtime.releaseObjectGroup" });
    await send("DOM.disable"); check(); commands.push({ method: "DOM.disable" });
    const boundaryObservation = { schema: "native-browser-dom-boundary/v1", observer, document, commands };
    replayNativeBoundary(boundaryObservation, observer);
    candidate = { ...read.result.value, boundaryObservation: read.result.value.failure === null ? boundaryObservation : null };
  } catch { candidate = failed(); }
  finally {
    closing = true; teardownUntil = Math.max(readUntil, Date.now()) + limit;
    if (!session && opening) {
      try { await within(opening, teardownUntil); } catch { candidate = failed(); }
    }
    if (session) {
      try {
        if (world && watching) {
          try { await clearOwned(session, teardownUntil); }
          catch {
            candidate = failed();
            // The continuation owns late resources even after our bounded wait ends.
            const recovery = Promise.resolve().then(() => page.context().newCDPSession(page)).then(async (active) => {
              const until = disposalUntil();
              try { await clearOwned(active, until); }
              finally { await detach(active, until); }
            });
            await within(recovery, teardownUntil);
          }
        }
      } catch { candidate = failed(); }
      try { await detach(session, teardownUntil); } catch { candidate = failed(); }
    }
  }
  return candidate;
}

function replayNativeBoundary(boundary, observer) {
  exact(boundary, ["schema", "observer", "document", "commands"]);
  assert.equal(boundary.schema, "native-browser-dom-boundary/v1"); assert.equal(boundary.observer, observer);
  exact(boundary.document, ["nodeId", "backendNodeId", "frameId", "loaderId"]);
  for (const key of ["frameId", "loaderId"]) assert.match(boundary.document[key], /^[a-zA-Z0-9_.:-]{1,128}$/);
  const nodes = new Map(), ids = new Set(), backends = new Set(); let at = 0;
  const take = (method) => { const command = boundary.commands[at++]; assert.ok(command); assert.equal(command.method, method); return command; };
  const add = (records, roots) => {
    assert.ok(Array.isArray(records) && records.length <= 10000);
    for (const n of records) {
      exact(n, ["nodeId", "backendNodeId", "nodeType", "kind", "childNodeCount", "children", "templateContent", "shadowRoots"]);
      assert.ok(Number.isInteger(n.nodeType) && n.nodeType >= 1 && n.nodeType <= 12);
      assert.ok(["ordinary", "template", "document-element"].includes(n.kind));
      assert.ok(Number.isSafeInteger(n.childNodeCount) && n.childNodeCount >= 0 && n.childNodeCount <= 10000);
      assert.ok(n.children === null ? n.childNodeCount > 0 : Array.isArray(n.children) && n.children.length === n.childNodeCount);
      assert.equal(n.kind === "template", n.templateContent !== null);
      assert.ok(Array.isArray(n.shadowRoots) && (n.nodeType === 1 || n.shadowRoots.length === 0));
      for (const r of n.shadowRoots) { exact(r, ["nodeId", "backendNodeId", "type"]); assert.equal(r.type, "user-agent"); }
      for (const member of [n, ...n.shadowRoots]) {
        assert.ok(Number.isSafeInteger(member.nodeId) && member.nodeId > 0 && !ids.has(member.nodeId)); ids.add(member.nodeId);
        assert.ok(Number.isSafeInteger(member.backendNodeId) && member.backendNodeId > 0 && !backends.has(member.backendNodeId)); backends.add(member.backendNodeId);
      }
      assert.ok(ids.size <= 10000); nodes.set(n.nodeId, structuredClone(n));
    }
    const batch = new Map(records.map((n) => [n.nodeId, n])), seen = new Set(), queue = [...roots];
    for (let i = 0; i < queue.length; i++) {
      const n = batch.get(queue[i]); assert.ok(n && !seen.has(n.nodeId)); seen.add(n.nodeId);
      queue.push(...n.children ?? []); if (n.templateContent !== null) queue.push(n.templateContent); assert.ok(queue.length <= 10000);
    }
    assert.deepEqual([...seen], records.map((n) => n.nodeId));
  };
  assert.ok(Array.isArray(boundary.commands) && boundary.commands.length <= 10013);
  exact(take("DOM.enable"), ["method"]);
  assert.deepEqual(take("Page.getFrameTree"), { method: "Page.getFrameTree", frameId: boundary.document.frameId, loaderId: boundary.document.loaderId, childFrames: [] });
  assert.deepEqual(take("DOM.getDocument"), { method: "DOM.getDocument", role: "observer-document", backendNodeId: boundary.document.backendNodeId,
    frameId: boundary.document.frameId, loaderId: boundary.document.loaderId });
  const isolated = take("Page.createIsolatedWorld"); exact(isolated, ["method", "frameId", "executionContextId"]);
  assert.equal(isolated.frameId, boundary.document.frameId); const world = isolated.executionContextId; assert.ok(Number.isSafeInteger(world) && world > 0);
  const start = take("Runtime.callFunctionOn"); exact(start, ["method", "role", "executionContextId", "result"]);
  assert.equal(start.role, "mutation-start"); assert.equal(start.executionContextId, world); exact(start.result, ["observer", "roots"]);
  assert.equal(start.result.observer, observer); assert.ok(Number.isSafeInteger(start.result.roots) && start.result.roots > 0 && start.result.roots <= 10000);
  const initial = take("DOM.getDocument"); exact(initial, ["method", "root", "nodes"]); assert.equal(initial.root, boundary.document.nodeId); add(initial.nodes, [initial.root]);
  for (const n of nodes.values()) if (n.children === null) {
    const c = take("DOM.requestChildNodes"); exact(c, ["method", "nodeId", "children", "nodes"]);
    assert.equal(c.nodeId, n.nodeId); assert.ok(Array.isArray(c.children) && c.children.length === n.childNodeCount);
    n.children = c.children; add(c.nodes, c.children);
  }
  const root = nodes.get(initial.root); assert.ok(root); assert.equal(root.nodeType, 9); assert.equal(root.backendNodeId, boundary.document.backendNodeId);
  const visited = new Set(), queue = [initial.root];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], n = nodes.get(id); assert.ok(n && !visited.has(id)); visited.add(id);
    assert.ok(id === initial.root || n.nodeType !== 9); assert.ok(Array.isArray(n.children)); queue.push(...n.children);
    if (n.templateContent !== null) { assert.equal(n.nodeType, 1); assert.equal(nodes.get(n.templateContent)?.nodeType, 11); queue.push(n.templateContent); }
    assert.ok(queue.length <= 10000);
  }
  assert.equal(visited.size, nodes.size);
  const elements = [...nodes.values()].filter((n) => n.kind === "document-element");
  assert.equal(elements.length, 1); assert.equal(elements[0].nodeType, 1); assert.ok(root.children.includes(elements[0].nodeId));
  assert.equal(start.result.roots, 1 + [...nodes.values()].filter((n) => n.kind === "template").length);
  assert.deepEqual(take("DOM.resolveNode"), { method: "DOM.resolveNode", role: "semantic-read", ...boundary.document });
  assert.deepEqual(take("Runtime.callFunctionOn"), { method: "Runtime.callFunctionOn", role: "semantic-read", ...boundary.document, observer });
  assert.deepEqual(take("DOM.describeNode"), { method: "DOM.describeNode", ...boundary.document });
  assert.deepEqual(take("DOM.resolveNode"), { method: "DOM.resolveNode", role: "mutation-check", ...boundary.document, executionContextId: world });
  assert.deepEqual(take("Runtime.callFunctionOn"), { method: "Runtime.callFunctionOn", role: "mutation-check", ...boundary.document, executionContextId: world,
    result: { observer, roots: start.result.roots, mutations: [] } });
  assert.deepEqual(take("Runtime.callFunctionOn"), { method: "Runtime.callFunctionOn", role: "mutation-cleanup", ...boundary.document, executionContextId: world, observer, result: { observer } });
  exact(take("Runtime.releaseObjectGroup"), ["method"]); exact(take("DOM.disable"), ["method"]); assert.equal(at, boundary.commands.length);
}

/** No caller-selected code: this function composes only installed fixed sources. */
export async function collectBrowserDOM(page, identity) {
  exact(identity, ["context", "case", "action", "scope", "originatingResponse"]); identityFields(identity);
  const observer = randomUUID(), startedAt = Date.now();
  // Reject secret/unknown current URL without returning that URL in a receipt.
  const url = publicBrowserURL(page.url(), page.url(), true);
  const collect = new Function("identity", `if(this !== document || globalThis !== globalThis.top) throw Error("native-dom-snapshot-failed");
    return (${recordBrowserDOM.toString()})(identity,
    (document,location,globalThis,getComputedStyle,URL)=>(${snapshotPage.toString()}),
    (document,getComputedStyle)=>(${missingSnapshot.toString()}),
    ${publicBrowserURL.toString()},${JSON.stringify(errorTexts)});`);
  const transcript = await readNativeBoundary(page, { ...identity, url }, collect, observer, startedAt);
  const observation = { schema: "native-browser-dom-observation/v1", observer, ...identity,
    readInterval: { startedAt, finishedAt: Date.now() }, url, snapshotSha256, ...transcript };
  assert.ok(encoded(observation).length <= 32 * 1024 ** 2);
  expectedShape({ observer, ...identity, readInterval: observation.readInterval, url });
  return observation;
}

export function replayBrowserDOM(observation, expectedIdentity, nativeDocument) {
  expectedShape(expectedIdentity);
  if (nativeDocument !== undefined) {
    exact(nativeDocument, ["frameId", "loaderId"]);
    for (const key of ["frameId", "loaderId"]) assert.match(nativeDocument[key], /^[a-zA-Z0-9_.:-]{1,128}$/);
  }
  exact(observation, ["schema", ...Object.keys(expectedIdentity), "snapshotSha256", "roots", "events", "result", "failure", "scopeObservation", "urlObservation", "boundaryObservation"]);
  assert.equal(observation.schema, "native-browser-dom-observation/v1"); assert.equal(observation.snapshotSha256, snapshotSha256);
  for (const key of Object.keys(expectedIdentity)) assert.deepEqual(observation[key], expectedIdentity[key]);
  assert.ok(encoded(observation).length <= 32 * 1024 ** 2);
  assert.deepEqual(observation.roots, { document: 0, location: 1, global: 2 });
  assert.ok(Array.isArray(observation.events) && observation.events.length <= 30000);
  if (observation.failure !== null) {
    assert.ok(["credential-filter-blocked", "public-error-unavailable", "native-scope-mismatch", "native-dom-snapshot-failed"].includes(observation.failure));
    assert.deepEqual(observation.events, []); assert.deepEqual(observation.result, unknown());
    assert.equal(observation.scopeObservation, null); assert.equal(observation.urlObservation, null); assert.equal(observation.boundaryObservation, null); return unknown();
  }
  replayNativeBoundary(observation.boundaryObservation, observation.observer);
  if (nativeDocument !== undefined) {
    const { frameId, loaderId } = observation.boundaryObservation.document;
    assert.deepEqual({ frameId, loaderId }, nativeDocument, "Native DOM document differs from caller-bound native document");
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
