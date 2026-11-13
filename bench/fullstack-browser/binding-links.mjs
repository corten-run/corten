import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bindingFunctionText, bindingHash, indexBindingArtifact } from "./binding-artifact.mjs";
import { effectFreeNames } from "./binding-effects.mjs";
import { bindingRealm } from "./binding-intrinsics.mjs";
import { emittedModules, reactContract } from "./binding-modules.mjs";
import ts from "typescript";
import { performance } from "node:perf_hooks";
const observers = new WeakMap();
export async function observeFormConstruction(cdp, documentNode, windowObject, group) {
  const startedAt = performance.now();
  const documentObject = (await cdp.send("DOM.resolveNode", { nodeId: documentNode, objectGroup: group })).object;
  assert.ok(documentObject?.objectId && windowObject?.objectId, "Native form event targets unavailable");
  const targets = [];
  for (const [kind, objectId, depth] of [["document-tree", documentObject.objectId, -1], ["window", windowObject.objectId, 0]]) {
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId, depth, pierce: true });
    assert.ok(Array.isArray(listeners) && listeners.length <= 8192, "Native form event inventory unavailable/exceeds bound");
    targets.push({ kind, listeners: listeners.filter((l) => l.type === "formdata").map((l) => ({ type: l.type,
      useCapture: l.useCapture, backendNodeId: l.backendNodeId ?? null, scriptId: l.scriptId, lineNumber: l.lineNumber, columnNumber: l.columnNumber })) });
  }
  return { startedAt, finishedAt: performance.now(), outcome: targets.every((t) => t.listeners.length === 0) ? "absent" : "present", targets };
}
// CDP own descriptors, not a JS sparse array: array iteration skips holes.
export function denseBindingEntries(descriptors) {
  const lengths = descriptors.filter((p) => p.name === "length"), length = lengths[0];
  assert.ok(lengths.length === 1 && length.isOwn && length.value?.type === "number" && !length.get && !length.set && !length.symbol
    && Number.isInteger(length.value.value) && length.value.value >= 0 && length.value.value <= 4096, "Unsupported native array length");
  const rows = descriptors.filter((p) => p !== length), indexed = new Map();
  assert.equal(rows.length, length.value.value, "Sparse native array unsupported");
  for (const row of rows) {
    assert.ok(row.isOwn && row.value && !row.get && !row.set && !row.symbol && /^(?:0|[1-9]\d*)$/.test(row.name)
      && Number(row.name) < length.value.value && !indexed.has(row.name), "Unsupported native array index/descriptor");
    indexed.set(row.name, row);
  }
  return Array.from({ length: length.value.value }, (_, i) => {
    const row = indexed.get(String(i)); assert.ok(row, "Sparse native array unsupported"); return row;
  });
}
export async function observeBindingLinks(cdp, selector, base, window = null) {
  return observers.get(cdp)?.capture(selector, base, window) ?? { outcome: "unknown", reason: "Immutable emitted binding artifact/native observer unavailable" };
}

// Installed by the harness before application scripts, not supplied by the page.
// Retain identities/descriptors, not just names or Function#toString spellings.
export function installBindingIntrinsics() {
  const descriptor = Object.getOwnPropertyDescriptor, arrayIterator = Object.getPrototypeOf([][Symbol.iterator]()), iterator = Object.getPrototypeOf(arrayIterator), values = {
    Map, Array, URLSearchParams, FormData, String, encodeURIComponent, Intl, fetch,
    "Array.species": descriptor(Array, Symbol.species).get,
    OwnDescriptor: descriptor, SpeciesKey: Symbol.species,
    IteratorKey: Symbol.iterator, "Array.iterator": descriptor(Array.prototype, Symbol.iterator).value,
    ArrayIteratorPrototype: arrayIterator, IteratorPrototype: iterator, "ArrayIterator.next": descriptor(arrayIterator, "next").value,
    ArrayIteratorKeys: JSON.stringify(Object.getOwnPropertyNames(arrayIterator).sort()),
    IteratorKeys: JSON.stringify(Object.getOwnPropertyNames(iterator).sort()),
    ReactFragment: Symbol.for("react.fragment"), ReactElement: Symbol.for("react.transitional.element"),
    NumberFormat: Intl.NumberFormat, PluralRules: Intl.PluralRules,
    StringPrototype: String.prototype, SearchPrototype: URLSearchParams.prototype, FormDataPrototype: FormData.prototype,
    ObjectPrototypeKeys: JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort()),
    ArrayPrototype: Array.prototype, ObjectPrototype: Object.prototype, MapPrototype: Map.prototype,
    NumberFormatPrototype: Intl.NumberFormat.prototype, PluralRulesPrototype: Intl.PluralRules.prototype,
  };
  for (const [owner, keys] of [[Array.prototype, ["map", "filter", "slice", "sort"]], [Map.prototype, ["get", "set"]],
    [Intl.NumberFormat.prototype, ["format"]], [Intl.PluralRules.prototype, ["select"]],
    [String.prototype, ["startsWith"]], [URLSearchParams.prototype, ["toString"]], [FormData.prototype, ["get"]]])
    for (const key of keys) {
      const d = descriptor(owner, key);
      values[(owner === Array.prototype ? "Array." : owner === Map.prototype ? "Map." : owner === Intl.NumberFormat.prototype ? "NumberFormat."
        : owner === Intl.PluralRules.prototype ? "PluralRules." : owner === String.prototype ? "String." : owner === FormData.prototype ? "FormData." : "Search.") + key] = d.value ?? d.get;
    }
  Object.defineProperty(globalThis, "__cortenBindingIntrinsics$v1", { value: Object.freeze(values) });
}

export class BindingLinkObserver {
  constructor(cdp, artifact) { this.cdp = cdp; this.artifact = artifact; this.scripts = new Map(); this.contexts = new Map(); this.failures = []; }
  async enable() {
    this.onScript = (row) => this.scripts.set(row.scriptId, { scriptId: row.scriptId, url: row.url, executionContextId: row.executionContextId });
    this.cdp.on("Debugger.scriptParsed", this.onScript);
    this.onContext = ({ context }) => this.contexts.set(context.id, { uniqueId: context.uniqueId, frame: context.auxData?.frameId, default: context.auxData?.isDefault === true });
    this.onDestroyed = (e) => this.contexts.delete(e.executionContextId);
    this.onCleared = () => this.contexts.clear();
    this.cdp.on("Runtime.executionContextCreated", this.onContext);
    this.cdp.on("Runtime.executionContextDestroyed", this.onDestroyed);
    this.cdp.on("Runtime.executionContextsCleared", this.onCleared);
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Page.enable");
    await this.cdp.send("Debugger.enable");
    this.init = (await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installBindingIntrinsics.toString()})()` })).identifier;
    observers.set(this.cdp, this);
  }
  async close() {
    observers.delete(this.cdp);
    if (this.onScript) this.cdp.off("Debugger.scriptParsed", this.onScript);
    for (const [event, listener] of [["Runtime.executionContextCreated", this.onContext], ["Runtime.executionContextDestroyed", this.onDestroyed], ["Runtime.executionContextsCleared", this.onCleared]])
      if (listener) this.cdp.off(event, listener);
    if (this.init) await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.init });
    // Other lifecycle observers own the CDP session; do not disable their domains.
  }
  async capture(selector, base, window = null) {
    const group = `binding-links-${randomUUID()}`, cdp = this.cdp, startedAt = performance.now();
    try {
      const nativeClock = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "Timestamp")?.value;
      const nativeStartedAt = window ? await nativeClock() : null;
      const index = indexBindingArtifact(this.artifact), functions = new Map(), checkedScripts = new Map(), pending = [], identities = [];
      const modules = emittedModules(index), callableInstances = new Map();
      let nodes = 0;
      const properties = async (objectId) => {
        assert.ok(objectId && ++nodes <= 12000, "Native binding descriptor bound exceeded");
        const result = await cdp.send("Runtime.getProperties", { objectId, ownProperties: true, generatePreview: false });
        assert.ok(!result.exceptionDetails, "Native descriptor read failed"); return result;
      };
      const data = async (objectId, name) => {
        const result = await properties(objectId), d = result.result.find((p) => p.name === name);
        assert.ok(d?.value && !d.get && !d.set, `Unknown/accessor binding ${name}`); return d.value;
      };
      const global = await cdp.send("Runtime.evaluate", { expression: "globalThis", objectGroup: group, silent: true });
      const realm = bindingRealm(global.result.objectId);
      const context = this.contexts.get(realm.context);
      const readScope = async () => {
        const answer = await cdp.send("Runtime.evaluate", { expression: "({realm:globalThis.__fullstackBrowserAudit?.checkpoint()?.realm,scope:globalThis.__fullstackBrowserAudit?.checkpoint()?.scope})",
          uniqueContextId: context.uniqueId, returnByValue: true, silent: true });
        assert.ok(!answer.exceptionDetails, "Binding resource identity unavailable"); return answer.result.value;
      };
      if (window) {
        assert.ok(context?.default && context.uniqueId && context.uniqueId === window.native.uniqueId && context.frame === window.native.frame
          && realm.context === window.native.context, "Binding native unique context changed");
        assert.deepEqual(await readScope(), { realm: window.resources.realm, scope: window.resources.scope }, "Binding resource scope changed");
      }
      const box = await data(global.result.objectId, "__cortenBindingIntrinsics$v1"), snapshot = await properties(box.objectId);
      const intrinsic = new Map(snapshot.result.filter((p) => p.value?.objectId).map((p) => [p.name, p.value]));
      const same = async (a, b, label) => {
        if (!a?.objectId || !b?.objectId) return false;
        const answer = await cdp.send("Runtime.callFunctionOn", { objectId: a.objectId,
          functionDeclaration: "function(a,b){return a===b}", arguments: [{ objectId: a.objectId }, { objectId: b.objectId }], returnByValue: true, silent: true });
        if (answer.result?.value !== true || answer.exceptionDetails) return false;
        identities.push({ label, observed: a.objectId, snapshot: b.objectId }); return true;
      };
      const method = async (object, key, expected, accessor = false) => {
        const d = (await properties(object.objectId)).result.find((p) => p.name === key);
        assert.ok(d && (!d.set || d.set.type === "undefined") && await same(accessor ? d.get : d.value, intrinsic.get(expected), expected), `Changed intrinsic ${expected}`);
      };
      for (const name of ["Map", "Array", "URLSearchParams", "FormData", "String", "encodeURIComponent", "Intl", "fetch"])
        assert.ok(await same(await data(global.result.objectId, name), intrinsic.get(name), name), `Changed global intrinsic ${name}`);
      assert.ok(await same(await data(intrinsic.get("Array").objectId, "prototype"), intrinsic.get("ArrayPrototype"), "ArrayPrototype"), "Changed native array prototype");
      assert.ok(await same(await data(intrinsic.get("ArrayPrototype").objectId, "constructor"), intrinsic.get("Array"), "Array.constructor"), "Changed array allocation constructor");
      assert.ok(await same(intrinsic.get("ObjectPrototype"), intrinsic.get("ObjectPrototype"), "ObjectPrototype"), "Native plain-data prototype unavailable");
      // CDP materializes some native accessor values instead of exposing their
      // descriptor. Call only the captured native descriptor intrinsic, never a
      // candidate getter, to distinguish it from a replaced species accessor.
      const species = await cdp.send("Runtime.callFunctionOn", { objectId: intrinsic.get("OwnDescriptor").objectId,
        functionDeclaration: "function(target,key){return this(target,key)}",
        arguments: [{ objectId: intrinsic.get("Array").objectId }, { objectId: intrinsic.get("SpeciesKey").objectId }], silent: true, objectGroup: group });
      assert.ok(!species.exceptionDetails && species.result?.objectId, "Array allocation descriptor unavailable");
      const speciesFields = (await properties(species.result.objectId)).result;
      assert.ok(speciesFields.find((p) => p.name === "set")?.value?.type === "undefined"
        && await same(speciesFields.find((p) => p.name === "get")?.value, intrinsic.get("Array.species"), "Array.species"), "Changed array allocation species");
      const iteratorDescriptor = await cdp.send("Runtime.callFunctionOn", { objectId: intrinsic.get("OwnDescriptor").objectId,
        functionDeclaration: "function(target,key){return this(target,key)}", arguments: [{ objectId: intrinsic.get("ArrayPrototype").objectId }, { objectId: intrinsic.get("IteratorKey").objectId }], silent: true, objectGroup: group });
      assert.ok(!iteratorDescriptor.exceptionDetails && iteratorDescriptor.result?.objectId, "Array iterator descriptor unavailable");
      assert.ok(await same(await data(iteratorDescriptor.result.objectId, "value"), intrinsic.get("Array.iterator"), "Array.iterator"), "Changed native array iterator");
      for (const [name, keys] of [["ArrayIteratorPrototype", "ArrayIteratorKeys"], ["IteratorPrototype", "IteratorKeys"]]) {
        const props = await properties(intrinsic.get(name).objectId);
        assert.equal(JSON.stringify(props.result.filter((p) => !p.symbol).map((p) => p.name).sort()), snapshot.result.find((p) => p.name === keys)?.value?.value, "Changed native iterator completion properties");
        const parent = props.internalProperties?.find((p) => p.name === "[[Prototype]]")?.value;
        assert.ok(await same(parent, intrinsic.get(name === "ArrayIteratorPrototype" ? "IteratorPrototype" : "ObjectPrototype"), name), "Changed native iterator prototype chain");
      }
      await method(intrinsic.get("ArrayIteratorPrototype"), "next", "ArrayIterator.next");
      for (const name of ["NumberFormat", "PluralRules"])
        assert.ok(await same(await data(intrinsic.get("Intl").objectId, name), intrinsic.get(name), name), `Changed Intl constructor ${name}`);
      const objectProperties = (await properties(intrinsic.get("ObjectPrototype").objectId)).result;
      assert.ok(!objectProperties.some((p) => p.symbol), "Unproved inherited dictionary iterator/coercion");
      const objectKeys = objectProperties.map((p) => p.name).sort();
      assert.equal(JSON.stringify(objectKeys), snapshot.result.find((p) => p.name === "ObjectPrototypeKeys")?.value?.value, "Changed plain-data prototype properties");
      for (const key of ["map", "filter", "slice", "sort"]) await method(intrinsic.get("ArrayPrototype"), key, `Array.${key}`);
      for (const key of ["get", "set"]) await method(intrinsic.get("MapPrototype"), key, `Map.${key}`);
      await method(intrinsic.get("NumberFormatPrototype"), "format", "NumberFormat.format", true);
      await method(intrinsic.get("PluralRulesPrototype"), "select", "PluralRules.select");
      await method(intrinsic.get("StringPrototype"), "startsWith", "String.startsWith");
      await method(intrinsic.get("SearchPrototype"), "toString", "Search.toString");
      assert.ok(await same(await data(intrinsic.get("FormData").objectId, "prototype"), intrinsic.get("FormDataPrototype"), "FormDataPrototype"), "Changed native form data prototype");
      await method(intrinsic.get("FormDataPrototype"), "get", "FormData.get");
      const locate = async (remote, capture = true) => {
        assert.equal(remote.type, "function");
        const props = await properties(remote.objectId);
        assert.ok(!props.internalProperties?.some((p) => /BoundTarget|ProxyTarget/.test(p.name)), "Bound/proxied callable unsupported");
        const location = props.internalProperties?.find((p) => p.name === "[[FunctionLocation]]")?.value?.value;
        assert.ok(location, "Callable lacks native source location");
        let script = checkedScripts.get(location.scriptId);
        if (!script) {
          const native = this.scripts.get(location.scriptId); assert.ok(native?.url, "Unobserved/evaluated callable script");
          assert.equal(native.executionContextId, realm.context, "Callable is from another native realm");
          const url = new URL(native.url); assert.equal(url.origin, new URL(base).origin);
          const source = (await cdp.send("Debugger.getScriptSource", { scriptId: location.scriptId })).scriptSource;
          const emitted = index.scripts.get(url.pathname);
          assert.ok(emitted && emitted.source === source && emitted.sha256 === bindingHash(source), "Executed script differs from immutable emitted artifact");
          script = { ...native, path: url.pathname, sha256: emitted.sha256 }; checkedScripts.set(location.scriptId, script);
        }
        const entry = index.locate(script.path, location.lineNumber, location.columnNumber);
        if (capture && functions.has(entry.id)) assert.ok(await same(remote, callableInstances.get(entry.id), "callable-instance"), "Different callable instances share an unsupported source location");
        if (capture && !functions.has(entry.id)) {
          const frame = { function: entry.id, location, bindings: {} };
          functions.set(entry.id, frame); pending.push({ remote, entry, props, frame });
          callableInstances.set(entry.id, remote);
          assert.ok(functions.size <= 48, "Binding callable graph exceeds supported bound");
        }
        return { kind: "function", function: entry.id, ...(!capture ? { location } : {}) };
      };
      const active = new Set();
      const encode = async (remote, borrowed = false, depth = 0, selected = null) => {
        assert.ok(remote && depth <= 12, "Unsupported/deep native binding value");
        if (remote.subtype === "null" || remote.type === "undefined") return { kind: "null" };
        if (["string", "number", "boolean"].includes(remote.type)) return { kind: "scalar", type: remote.type, ...(remote.type === "boolean" ? { value: remote.value } : {}) };
        if (remote.type === "symbol") {
          for (const key of ["ReactFragment", "ReactElement"]) if (await same(remote, intrinsic.get(key), key)) return { kind: "symbol", name: key };
          throw new Error("Unproved native symbol");
        }
        if (remote.type === "function") {
          for (const key of ["Map", "URLSearchParams", "FormData", "String", "encodeURIComponent", "fetch"])
            if (await same(remote, intrinsic.get(key), key)) return { kind: "intrinsic", name: key, identity: identities.length - 1 };
          assert.ok(!borrowed, "Callable inside borrowed application data"); return locate(remote);
        }
        assert.equal(remote.type, "object"); assert.ok(remote.objectId && remote.subtype !== "proxy", "Unknown/proxied native binding");
        if (await same(remote, intrinsic.get("Intl"), "Intl")) return { kind: "intrinsic", name: "Intl", identity: identities.length - 1 };
        assert.ok(!active.has(remote.objectId), "Cyclic/aliased native data graph unsupported"); active.add(remote.objectId);
        try {
          const result = await properties(remote.objectId), prototype = result.internalProperties?.find((p) => p.name === "[[Prototype]]")?.value;
          if (selected?.length && remote.subtype !== "map") {
            assert.ok(!borrowed, "Selective reads cannot attest borrowed props");
            const fields = {};
            for (const key of selected) {
              const p = result.result.find((p) => p.name === key);
              assert.ok(p?.isOwn && (!p.set || p.set.type === "undefined"), "Unresolved native namespace field");
              if (p.value) fields[key] = await encode(p.value, false, depth + 1);
              else {
                assert.ok(p.get, "Missing namespace descriptor"); const getter = await locate(p.get, false), entry = index.functions.get(getter.function);
                const body = entry.node.body;
                assert.ok(body && ts.isElementAccessExpression(body) && ts.isIdentifier(body.expression) && ts.isIdentifier(body.argumentExpression), "Effectful native export getter");
                const native = await properties(p.get.objectId), scopes = native.internalProperties?.find((p) => p.name === "[[Scopes]]")?.value;
                assert.ok(scopes?.objectId, "Export getter scope unavailable");
                const slots = (await properties(scopes.objectId)).result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId), scope = [];
                for (const slot of slots) scope.push(...(await properties(slot.value.objectId)).result);
                const receiver = scope.find((p) => p.name === body.expression.text)?.value, slotKey = scope.find((p) => p.name === body.argumentExpression.text)?.value;
                assert.ok(receiver?.objectId && slotKey?.type === "string", "Unresolved export getter lexical edge");
                fields[key] = { kind: "getterRead", function: getter.function, location: getter.location, key: slotKey.value, receiver: await encode(receiver, false, depth + 1, [slotKey.value]) };
              }
            }
            return { kind: "object", fields };
          }
          if (remote.subtype === "map") {
            assert.ok(!borrowed && await same(prototype, intrinsic.get("MapPrototype"), "MapPrototype"), "Borrowed/foreign cache");
            assert.ok(!result.result.some((p) => p.isOwn && !/^\d+$/.test(p.name)), "Overridden native cache");
            const entries = result.internalProperties?.find((p) => p.name === "[[Entries]]")?.value;
            assert.ok(entries?.objectId, "Cache entry descriptors unavailable");
            const rows = (await properties(entries.objectId)).result.filter((p) => /^\d+$/.test(p.name));
            assert.ok(rows.length <= 16, "Cache exceeds supported bound");
            const values = [];
            for (const row of rows) {
              const fields = (await properties(row.value?.objectId)).result;
              const key = fields.find((p) => p.name === "key")?.value, value = fields.find((p) => p.name === "value")?.value;
              assert.ok(key && ["string", "number", "boolean"].includes(key.type) && value, "Unproved cache key/value");
              values.push(await encode(value, false, depth + 1));
            }
            return { kind: "cache", values };
          }
          for (const [name, type] of [["NumberFormatPrototype", "Intl.NumberFormat"], ["PluralRulesPrototype", "Intl.PluralRules"]])
            if (!borrowed && await same(prototype, intrinsic.get(name), name)) {
              assert.ok(!result.result.length, "Overridden formatter instance"); return { kind: "intl", type };
            }
          const array = remote.subtype === "array";
          assert.ok(array ? await same(prototype, intrinsic.get("ArrayPrototype"), "ArrayPrototype")
            : prototype?.subtype === "null" || await same(prototype, intrinsic.get("ObjectPrototype"), "ObjectPrototype"), "Unproved data prototype/getters");
          const fields = {}, items = [];
          for (const p of array ? denseBindingEntries(result.result) : result.result) {
            assert.ok(p.isOwn && p.value && !p.get && !p.set && !p.symbol
              && !["__proto__", "prototype", "constructor"].includes(p.name), "Unsupported data property/accessor");
            if (array) items.push(await encode(p.value, borrowed, depth + 1));
            else fields[p.name] = await encode(p.value, borrowed, depth + 1);
          }
          return array ? { kind: "array", fresh: false, items } : { kind: borrowed ? "borrowed" : "object", fields };
        } finally { active.delete(remote.objectId); }
      };
      const document = await cdp.send("DOM.getDocument", { depth: 0 });
      const found = await cdp.send("DOM.querySelector", { nodeId: document.root.nodeId, selector });
      assert.ok(found.nodeId, "Mounted form unavailable");
      const form = (await cdp.send("DOM.resolveNode", { nodeId: found.nodeId, objectGroup: group })).object;
      const formProps = await properties(form.objectId);
      const reactProps = formProps.result.find((p) => p.name.startsWith("__reactProps$") && p.value?.objectId && !p.get && !p.set)?.value;
      let fiber = formProps.result.find((p) => p.name.startsWith("__reactFiber$") && p.value?.objectId && !p.get && !p.set)?.value;
      assert.ok(reactProps && fiber, "Native React mount descriptors unavailable");
      const handlerRemote = await data(reactProps.objectId, "onSubmit"), handler = await locate(handlerRemote);
      const seen = new Set(); let owner, props, id, locale, ownerFiber;
      while (fiber?.objectId && !seen.has(fiber.objectId) && seen.size < 100) {
        seen.add(fiber.objectId);
        const values = await properties(fiber.objectId), get = (name) => values.result.find((p) => p.name === name && p.value && !p.get && !p.set)?.value;
        const type = get("type"), memoized = get("memoizedProps");
        if (type?.type === "function" && memoized?.objectId) {
          const fields = await properties(memoized.objectId), record = fields.result.find((p) => p.name === "record" && p.value && !p.get && !p.set)?.value;
          const lang = fields.result.find((p) => p.name === "locale" && p.value && !p.get && !p.set)?.value;
          if (record?.objectId && lang?.type === "string") {
            const recordId = await data(record.objectId, "id");
            if (recordId.type === "string") { owner = await locate(type); props = await encode(memoized, true); id = recordId.value; locale = lang.value; ownerFiber = fiber; break; }
          }
        }
        fiber = get("return");
      }
      assert.ok(owner, "Owning component/props unavailable");
      const hooks = [], hookValues = [];
      const optional = async (remote, key) => (await properties(remote.objectId)).result.find((p) => p.name === key && p.value && !p.get && !p.set)?.value;
      let slot = await optional(ownerFiber, "memoizedState");
      while (slot?.objectId && hooks.length < 16) {
        const value = await data(slot.objectId, "memoizedState"), queue = await data(slot.objectId, "queue");
        if (queue.subtype === "null") {
          const descriptor = value.objectId ? (await properties(value.objectId)).result.find((p) => p.name === "current") : null;
          const current = descriptor?.value;
          assert.ok(descriptor?.isOwn && descriptor.writable && !descriptor.get && !descriptor.set && current?.type === "boolean", "Unsupported native ref hook state");
          hooks.push({ kind: "ref", current: current.value }); hookValues.push({ ref: value });
        } else {
          assert.ok(["boolean", "string", "number", "undefined"].includes(value.type) || value.subtype === "null", "Unsupported native scalar hook state");
          const dispatch = await data(queue.objectId, "dispatch"), reducer = await data(queue.objectId, "lastRenderedReducer");
          const internals = (await properties(dispatch.objectId)).internalProperties;
          const target = internals?.find((p) => p.name === "[[TargetFunction]]")?.value;
          const args = internals?.find((p) => p.name === "[[BoundArgs]]")?.value;
          assert.ok(target && args, "Unsupported native state dispatcher");
          const boundFiber = await data(args.objectId, "0"), boundQueue = await data(args.objectId, "1");
          assert.equal((await data(args.objectId, "length")).value, 2, "Native dispatcher has unsupported bound arguments");
          const alternate = await optional(ownerFiber, "alternate");
          assert.ok(await same(boundFiber, ownerFiber, "hook-fiber") || alternate?.objectId && await same(boundFiber, alternate, "hook-fiber"), "Native hook dispatcher belongs to another component");
          const fiberIdentity = identities.length - 1;
          assert.ok(await same(boundQueue, queue, "hook-queue"), "Native dispatcher queue differs");
          const queueIdentity = identities.length - 1;
          hooks.push({ kind: "state", value: value.subtype === "null" || value.type === "undefined" ? { kind: "null" }
            : { kind: "scalar", type: value.type, ...(value.type === "boolean" ? { value: value.value } : {}) },
            fiberIdentity, queueIdentity, target: await locate(target, false), reducer: await locate(reducer, false) }); hookValues.push({ dispatch });
        }
        slot = await optional(slot, "next");
      }
      assert.ok(!slot?.objectId, "Native hook inventory exceeds supported bound");
      const root = index.functions.get(owner.function), submit = index.functions.get(handler.function);
      const attributes = (await cdp.send("DOM.getAttributes", { nodeId: found.nodeId })).attributes;
      const formDataFields = {}, formIdAt = attributes.indexOf("id"), formId = formIdAt >= 0 ? attributes[formIdAt + 1] : null;
      const descendants = new Set((await cdp.send("DOM.querySelectorAll", { nodeId: found.nodeId, selector: "[name]" })).nodeIds);
      const controls = new Set([...descendants, ...(formId ? (await cdp.send("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector: "[form][name]" })).nodeIds : [])]);
      assert.ok(controls.size <= 128, "Native form field inventory exceeds supported bound");
      for (const nodeId of controls) {
        const row = (await cdp.send("DOM.describeNode", { nodeId, depth: 0 })).node, attrs = row.attributes ?? [];
        const get = (key) => { const at = attrs.indexOf(key); return at < 0 ? null : attrs[at + 1]; };
        if (get("form") !== null ? get("form") !== formId : !descendants.has(nodeId)) continue;
        const name = get("name"); if (!name) continue;
        const supported = ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(row.nodeName) && !(row.nodeName === "INPUT" && get("type")?.toLowerCase() === "file");
        Object.defineProperty(formDataFields, name, { value: supported && formDataFields[name] !== "unknown" ? "string" : "unknown", enumerable: true, configurable: true });
      }
      const constructionControls = [];
      const descendantsForConstruction = new Set((await cdp.send("DOM.querySelectorAll", { nodeId: found.nodeId, selector: "*" })).nodeIds);
      const associatedForConstruction = formId ? (await cdp.send("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector: "[form]" })).nodeIds : [];
      const constructionNodes = new Set([found.nodeId, ...descendantsForConstruction, ...associatedForConstruction]);
      assert.ok(constructionNodes.size <= 128, "Native form construction control inventory exceeds supported bound");
      for (const nodeId of constructionNodes) {
        const row = (await cdp.send("DOM.describeNode", { nodeId, depth: 0 })).node, attrs = row.attributes ?? [], formAt = attrs.indexOf("form");
        if (nodeId !== found.nodeId && formAt >= 0 && attrs[formAt + 1] !== formId) continue;
        constructionControls.push({ backendNodeId: row.backendNodeId, name: row.localName, customized: attrs.includes("is"),
          shadow: Boolean(row.shadowRoots?.some((root) => root.shadowRootType !== "user-agent")) });
      }
      const formConstruction = { ...await observeFormConstruction(cdp, document.root.nodeId, global.result, group),
        form: constructionControls[0].backendNodeId, controls: constructionControls };
      const actionAt = attributes.indexOf("action"), action = new URL(actionAt >= 0 ? attributes[actionAt + 1] : base, base).href;
      const candidate = { handlerSource: bindingFunctionText(submit), componentSource: bindingFunctionText(root), recordId: id, locale,
        action, base, basis: "mounted-react-emitted-module-and-native-scope-links" };
      // Scope values are read via descriptors. Neither the callback nor helper
      // source is evaluated, and accessors are never called to resolve an edge.
      while (pending.length) {
        const { remote, entry, props: native, frame } = pending.shift();
        if (reactContract(entry, modules)) continue;
        const scopes = native.internalProperties?.find((p) => p.name === "[[Scopes]]")?.value;
        assert.ok(scopes?.objectId, "Callable native scopes unavailable");
        const slots = (await properties(scopes.objectId)).result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).slice(0, 12);
        const values = [];
        for (const slot of slots) values.push((await properties(slot.value.objectId)).result);
        const references = [];
        const needed = effectFreeNames(entry.node, entry.id === submit.id ? null : candidate.handlerSource, (node) => references.push(node));
        for (const name of needed) {
          const d = values.flat().find((p) => p.name === name);
          if (entry.id === submit.id && !["FormData", "URLSearchParams", "String", "encodeURIComponent", "fetch"].includes(name)) {
            if (d?.value && !d.get && !d.set) for (let slot = 0; slot < hookValues.length; slot++) {
              for (const [key, kind] of [["ref", "hookRef"], ["dispatch", "hookSetter"]]) if (await same(d.value, hookValues[slot][key], `hook:${slot}:${kind}`))
                frame.bindings[name] = { kind, slot, identity: identities.length - 1 };
            }
            continue;
          }
          assert.ok(d?.value && !d.get && !d.set, `Native lexical edge unavailable: ${name}`);
          const fields = new Set(references.filter((n) => n.text === name && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n).map((n) => n.parent.name.text));
          try { frame.bindings[name] = await encode(d.value, false, 0, [...fields]); }
          catch (error) { frame.bindings[name] = { kind: "unknown", reason: error.message }; }
        }
        void remote;
      }
      const receipt = { schema: "native-binding-links/v1", artifactSha256: this.artifact.sha256, component: owner.function, handler: handler.function,
        recordId: id, locale, props, realmObjectId: global.result.objectId, executionContextId: realm.context,
        formConstruction, formDataFields, hooks, frames: [...functions.values()], scripts: [...checkedScripts.values()], intrinsicIdentities: identities };
      if (window) {
        assert.equal(formConstruction.form, window.form.backendNodeId, "Binding mounted form changed");
        const currentDocument = await cdp.send("DOM.getDocument", { depth: 0 });
        const currentForm = await cdp.send("DOM.querySelector", { nodeId: currentDocument.root.nodeId, selector });
        assert.equal((await cdp.send("DOM.describeNode", { nodeId: currentForm.nodeId, depth: 0 })).node.backendNodeId,
          window.form.backendNodeId, "Binding form replaced during capture");
        assert.deepEqual(this.contexts.get(realm.context), context, "Binding context changed during capture");
        assert.deepEqual(await readScope(), { realm: window.resources.realm, scope: window.resources.scope }, "Binding resource scope changed during capture");
        const nativeFinishedAt = await nativeClock();
        receipt.observation = { id: randomUUID(), window: window.id, instance: window.instance, case: window.case, action: window.action,
          startedAt, finishedAt: performance.now(), nativeStartedAt, nativeFinishedAt,
          context: realm.context, uniqueId: context.uniqueId, frame: context.frame, realm: window.resources.realm, scope: window.resources.scope,
          form: formConstruction.form };
      }
      return { candidate, receipt, linked: { artifact: this.artifact, receipt }, outcome: "observed" };
    } catch (error) { return { outcome: "unknown", reason: error.message }; }
    finally { await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }); }
  }
}
