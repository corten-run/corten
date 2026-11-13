import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bindingFunctionText, bindingHash, indexBindingArtifact } from "./binding-artifact.mjs";
import { effectFreeNames } from "./binding-effects.mjs";
import { bindingRealm } from "./binding-intrinsics.mjs";
const observers = new WeakMap();
export async function observeBindingLinks(cdp, selector, base) {
  return observers.get(cdp)?.capture(selector, base) ?? { outcome: "unknown", reason: "Immutable emitted binding artifact/native observer unavailable" };
}

// Installed by the harness before application scripts, not supplied by the page.
// Retain identities/descriptors, not just names or Function#toString spellings.
export function installBindingIntrinsics() {
  const descriptor = Object.getOwnPropertyDescriptor, values = {
    Map, Array, URLSearchParams, FormData, String, encodeURIComponent, Intl, fetch,
    "Array.species": descriptor(Array, Symbol.species).get,
    OwnDescriptor: descriptor, SpeciesKey: Symbol.species,
    NumberFormat: Intl.NumberFormat, PluralRules: Intl.PluralRules,
    StringPrototype: String.prototype, SearchPrototype: URLSearchParams.prototype,
    ObjectPrototypeKeys: JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort()),
    ArrayPrototype: Array.prototype, ObjectPrototype: Object.prototype, MapPrototype: Map.prototype,
    NumberFormatPrototype: Intl.NumberFormat.prototype, PluralRulesPrototype: Intl.PluralRules.prototype,
  };
  for (const [owner, keys] of [[Array.prototype, ["map", "filter", "slice", "sort"]], [Map.prototype, ["get", "set"]],
    [Intl.NumberFormat.prototype, ["format"]], [Intl.PluralRules.prototype, ["select"]],
    [String.prototype, ["startsWith"]], [URLSearchParams.prototype, ["toString"]]])
    for (const key of keys) {
      const d = descriptor(owner, key);
      values[(owner === Array.prototype ? "Array." : owner === Map.prototype ? "Map." : owner === Intl.NumberFormat.prototype ? "NumberFormat."
        : owner === Intl.PluralRules.prototype ? "PluralRules." : owner === String.prototype ? "String." : "Search.") + key] = d.value ?? d.get;
    }
  Object.defineProperty(globalThis, "__cortenBindingIntrinsics$v1", { value: Object.freeze(values) });
}

export class BindingLinkObserver {
  constructor(cdp, artifact) { this.cdp = cdp; this.artifact = artifact; this.scripts = new Map(); this.failures = []; }
  async enable() {
    this.onScript = (row) => this.scripts.set(row.scriptId, { scriptId: row.scriptId, url: row.url, executionContextId: row.executionContextId });
    this.cdp.on("Debugger.scriptParsed", this.onScript);
    await this.cdp.send("Page.enable");
    await this.cdp.send("Debugger.enable");
    this.init = (await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installBindingIntrinsics.toString()})()` })).identifier;
    observers.set(this.cdp, this);
  }
  async close() {
    observers.delete(this.cdp);
    if (this.onScript) this.cdp.off("Debugger.scriptParsed", this.onScript);
    if (this.init) await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.init });
    // Other lifecycle observers own the CDP session; do not disable their domains.
  }
  async capture(selector, base) {
    const group = `binding-links-${randomUUID()}`, cdp = this.cdp;
    try {
      const index = indexBindingArtifact(this.artifact), functions = new Map(), checkedScripts = new Map(), pending = [], identities = [];
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
      for (const name of ["NumberFormat", "PluralRules"])
        assert.ok(await same(await data(intrinsic.get("Intl").objectId, name), intrinsic.get(name), name), `Changed Intl constructor ${name}`);
      const objectKeys = (await properties(intrinsic.get("ObjectPrototype").objectId)).result.map((p) => p.name).sort();
      assert.equal(JSON.stringify(objectKeys), snapshot.result.find((p) => p.name === "ObjectPrototypeKeys")?.value?.value, "Changed plain-data prototype properties");
      for (const key of ["map", "filter", "slice", "sort"]) await method(intrinsic.get("ArrayPrototype"), key, `Array.${key}`);
      for (const key of ["get", "set"]) await method(intrinsic.get("MapPrototype"), key, `Map.${key}`);
      await method(intrinsic.get("NumberFormatPrototype"), "format", "NumberFormat.format", true);
      await method(intrinsic.get("PluralRulesPrototype"), "select", "PluralRules.select");
      await method(intrinsic.get("StringPrototype"), "startsWith", "String.startsWith");
      await method(intrinsic.get("SearchPrototype"), "toString", "Search.toString");
      const locate = async (remote) => {
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
        if (!functions.has(entry.id)) {
          const frame = { function: entry.id, location, bindings: {} };
          functions.set(entry.id, frame); pending.push({ remote, entry, props, frame });
          assert.ok(functions.size <= 48, "Binding callable graph exceeds supported bound");
        }
        return { kind: "function", function: entry.id };
      };
      const active = new Set();
      const encode = async (remote, borrowed = false, depth = 0) => {
        assert.ok(remote && depth <= 12, "Unsupported/deep native binding value");
        if (remote.subtype === "null" || remote.type === "undefined") return { kind: "null" };
        if (["string", "number", "boolean"].includes(remote.type)) return { kind: "scalar", type: remote.type };
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
          for (const p of result.result) {
            if (array && p.name === "length") continue;
            assert.ok(p.isOwn && p.value && !p.get && !p.set && !p.symbol
              && !["__proto__", "prototype", "constructor"].includes(p.name), "Unsupported data property/accessor");
            if (array) { assert.match(p.name, /^(?:0|[1-9]\d*)$/); items[Number(p.name)] = await encode(p.value, borrowed, depth + 1); }
            else fields[p.name] = await encode(p.value, borrowed, depth + 1);
          }
          assert.ok(!array || items.every(Boolean), "Sparse borrowed array unsupported");
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
      const seen = new Set(); let owner, props, id, locale;
      while (fiber?.objectId && !seen.has(fiber.objectId) && seen.size < 100) {
        seen.add(fiber.objectId);
        const values = await properties(fiber.objectId), get = (name) => values.result.find((p) => p.name === name && p.value && !p.get && !p.set)?.value;
        const type = get("type"), memoized = get("memoizedProps");
        if (type?.type === "function" && memoized?.objectId) {
          const fields = await properties(memoized.objectId), record = fields.result.find((p) => p.name === "record" && p.value && !p.get && !p.set)?.value;
          const lang = fields.result.find((p) => p.name === "locale" && p.value && !p.get && !p.set)?.value;
          if (record?.objectId && lang?.type === "string") {
            const recordId = await data(record.objectId, "id");
            if (recordId.type === "string") { owner = await locate(type); props = await encode(memoized, true); id = recordId.value; locale = lang.value; break; }
          }
        }
        fiber = get("return");
      }
      assert.ok(owner, "Owning component/props unavailable");
      const root = index.functions.get(owner.function), submit = index.functions.get(handler.function);
      const attributes = (await cdp.send("DOM.getAttributes", { nodeId: found.nodeId })).attributes;
      const actionAt = attributes.indexOf("action"), action = new URL(actionAt >= 0 ? attributes[actionAt + 1] : base, base).href;
      const candidate = { handlerSource: bindingFunctionText(submit), componentSource: bindingFunctionText(root), recordId: id, locale,
        action, base, basis: "mounted-react-emitted-module-and-native-scope-links" };
      // Scope values are read via descriptors. Neither the callback nor helper
      // source is evaluated, and accessors are never called to resolve an edge.
      while (pending.length) {
        const { remote, entry, props: native, frame } = pending.shift();
        const scopes = native.internalProperties?.find((p) => p.name === "[[Scopes]]")?.value;
        assert.ok(scopes?.objectId, "Callable native scopes unavailable");
        const slots = (await properties(scopes.objectId)).result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).slice(0, 12);
        const values = [];
        for (const slot of slots) values.push((await properties(slot.value.objectId)).result);
        const needed = effectFreeNames(entry.node, candidate.handlerSource).filter((name) => entry.id !== submit.id
          || ["FormData", "URLSearchParams", "String", "encodeURIComponent", "fetch"].includes(name));
        for (const name of needed) {
          const d = values.flat().find((p) => p.name === name);
          assert.ok(d?.value && !d.get && !d.set, `Native lexical edge unavailable: ${name}`);
          try { frame.bindings[name] = await encode(d.value); }
          catch (error) { frame.bindings[name] = { kind: "unknown", reason: error.message }; }
        }
        void remote;
      }
      const receipt = { schema: "native-binding-links/v1", artifactSha256: this.artifact.sha256, component: owner.function, handler: handler.function,
        recordId: id, locale, props, realmObjectId: global.result.objectId, executionContextId: realm.context,
        frames: [...functions.values()], scripts: [...checkedScripts.values()], intrinsicIdentities: identities };
      return { candidate, receipt, linked: { artifact: this.artifact, receipt }, outcome: "observed" };
    } catch (error) { return { outcome: "unknown", reason: error.message }; }
    finally { await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }); }
  }
}
