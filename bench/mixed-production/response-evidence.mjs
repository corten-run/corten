import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { isDeepStrictEqual } from "node:util";
import { snapshotMixedPage } from "./snapshot.mjs";
import { bindNativeForm } from "../workloads/mixed.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const same = (a, b) => assert.ok(isDeepStrictEqual(a, b), "native response source differs");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const methods = ["querySelector", "querySelectorAll", "matches", "getAttribute", "contains", "cloneNode", "remove"];
const properties = ["documentElement", "localName", "hidden", "textContent", "disabled", "readOnly", "htmlFor", "id", "name", "method", "action", "type", "inputMode", "options", "lang", "display", "visibility", "opacity", "origin", "marketplaceInjected"];
export function responseSourceWriter(folder) {
  return (value) => {
    const bytes = JSON.stringify(value), hash = sha256(bytes), path = `response-sources/${hash}.json`, full = join(folder, path);
    mkdirSync(join(folder, "response-sources"), { recursive: true });
    if (existsSync(full)) same(readFileSync(full, "utf8"), bytes); else {
      try { writeFileSync(full, bytes, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; same(readFileSync(full, "utf8"), bytes); }
    }
    return { path, sha256: hash };
  };
}

// Runs only in the browser against the actual parsed native response. The source
// argument is the installed, pinned snapshot function, never saved artifact code.
export function collectDOMReads({ source, readPath }) {
  const events = [], objects = new Map(), originals = new Map(); let next = 0;
  const urlAttributes = ["action", "formaction", "href", "src", "data-src"];
  const publicQuery = (url, key) => {
    const entries = [...url.searchParams];
    if (new Set(entries.map(([name]) => name)).size !== entries.length) return false;
    if (entries.every(([, value]) => !value)) return true;
    // Only mixed's fixed marketplace page routes have a public query contract.
    // createPlan uses the fixture's first seller prefix, "A", not arbitrary text.
    if (key !== "href" || !/^\/marketplace\/(?:en-US|fr-FR|de-DE)\/item_([1-9]\d{0,2})$/.test(url.pathname)
      || Number(url.pathname.split("item_")[1]) > 500 || url.origin !== location.origin) return false;
    return entries.every(([name, value]) => {
      return name === "seller" ? ["", "A"].includes(value) : name === "sort" ? ["asc", "desc"].includes(value)
        : name === "offers" ? value === "all" : !value;
    });
  };
  let unsafeURL = false;
  const secrets = new Set([...document.querySelectorAll("input[type=hidden],meta")]
    .flatMap((el) => [el.getAttribute("value"), el.getAttribute("content")]).filter((v) => v?.length >= 8));
  for (const el of document.querySelectorAll("[action],[formaction],[href],[src],[data-src]")) for (const key of urlAttributes) {
    if (!el.hasAttribute(key)) continue;
    try {
      const url = new URL(el.getAttribute(key), location.href);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) unsafeURL = true;
      if (["action", "formaction"].includes(key)) {
        for (const value of url.searchParams.values()) if (value.length >= 8) secrets.add(value);
      } else if (!publicQuery(url, key)) unsafeURL = true;
    } catch { unsafeURL = true; }
  }
  const safe = (value, key) => {
    if (typeof value === "string" && urlAttributes.includes(key)) {
      const u = new URL(value, location.href);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hash || !["action", "formaction"].includes(key)
        && !publicQuery(u, key)) throw Error("credential-filter-blocked");
      if (["action", "formaction"].includes(key)) { u.search = ""; value = u.href; }
    }
    if (typeof value === "string" && (value.length > 131072 || [...secrets].some((s) => value.includes(s)))) throw Error("credential-filter-blocked");
    return value;
  };
  const idFor = (value) => { if (!objects.has(value)) objects.set(value, next++); return objects.get(value); };
  const encode = (value, key) => {
    if (value === undefined) return { undefined: true };
    if (value === null || ["string", "boolean", "number"].includes(typeof value)) return { scalar: safe(value, key) };
    if (Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection) return { list: [...value].map((v) => encode(v)) };
    return { object: idFor(value) };
  };
  const arg = (value) => originals.has(value) ? { object: idFor(originals.get(value)) } : encode(value);
  const decoded = (value) => {
    if ("scalar" in value) return value.scalar;
    if (value.undefined) return undefined;
    if (value.list) return value.list.map(decoded);
    return wrap([...objects].find(([, id]) => id === value.object)[0]);
  };
  const wrap = (target) => {
    const proxy = new Proxy({}, { get(_unused, key) {
      if (typeof key !== "string") throw Error("unsupported DOM access");
      const value = target[key];
      if (typeof value === "function") return (...args) => {
        if (!["querySelector", "querySelectorAll", "matches", "getAttribute", "contains", "cloneNode", "remove"].includes(key)) throw Error("unsupported DOM call");
        const result = encode(value.apply(target, args.map((v) => originals.get(v) ?? v)),
          key === "getAttribute" ? String(args[0]).toLowerCase() : key);
        events.push({ target: idFor(target), kind: "call", key, args: args.map(arg), result });
        if (events.length > 30000) throw Error("DOM read bound exceeded"); return decoded(result);
      };
      if (!["documentElement", "localName", "hidden", "textContent", "disabled", "readOnly", "htmlFor", "id", "name", "method", "action", "type", "inputMode", "options", "lang", "display", "visibility", "opacity", "origin", "marketplaceInjected"].includes(key)) throw Error("unsupported DOM property");
      const result = encode(value, key); events.push({ target: idFor(target), kind: "get", key, args: [], result });
      if (events.length > 30000) throw Error("DOM read bound exceeded"); return decoded(result);
    } }); originals.set(proxy, target); return proxy;
  };
  const roots = { document: idFor(document), location: idFor(location), global: idFor(globalThis) };
  if (unsafeURL) return { schema: "mixed-native-dom-reads/v1", roots, readPath, events, page: null, failure: "credential-filter-blocked" };
  const styles = (el) => {
    const target = originals.get(el), result = encode(getComputedStyle(target));
    events.push({ target: null, kind: "style", key: "getComputedStyle", args: [{ object: idFor(target) }], result }); return decoded(result);
  };
  const snapshot = new Function("document", "location", "globalThis", "getComputedStyle", "URL", `return (${source});`)
    (wrap(document), wrap(location), wrap(globalThis), styles, URL);
  try { return { schema: "mixed-native-dom-reads/v1", roots, readPath, events, page: snapshot({ readPath }), failure: null }; }
  catch (error) { return { schema: "mixed-native-dom-reads/v1", roots, readPath, events, page: null,
    failure: error.message === "credential-filter-blocked" ? "credential-filter-blocked" : "native-dom-snapshot-failed" }; }
}

export function replayDOMReads(receipt) {
  assert.ok(receipt && Object.keys(receipt).sort().join() === "events,failure,page,readPath,roots,schema");
  assert.equal(receipt.schema, "mixed-native-dom-reads/v1");
  assert.ok(receipt.roots && Object.keys(receipt.roots).sort().join() === "document,global,location");
  same(Object.values(receipt.roots).toSorted(), [0, 1, 2]);
  assert.ok([null, "native-dom-snapshot-failed"].includes(receipt.failure));
  assert.ok(Array.isArray(receipt.events) && receipt.events.length <= 30000);
  assert.ok(typeof receipt.readPath === "string" && /^\/(?!\/)[^?#\\\s]+$/.test(receipt.readPath));
  const refs = new Map(); let at = 0;
  const encode = (value) => refs.has(value) ? { object: refs.get(value) } : value === undefined ? { undefined: true } : { scalar: value };
  const decode = (value) => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1);
    if ("scalar" in value) { assert.ok(value.scalar === null || ["string", "number", "boolean"].includes(typeof value.scalar));
      if (typeof value.scalar === "string") assert.ok(value.scalar.length <= 131072); return value.scalar; }
    if ("undefined" in value) { assert.equal(value.undefined, true); return undefined; }
    if ("list" in value) { assert.ok(Array.isArray(value.list) && value.list.length <= 10000); return value.list.map(decode); }
    assert.ok(Number.isSafeInteger(value.object) && value.object >= 0 && value.object < 30000); return wrap(value.object);
  };
  const call = (target, kind, key, args) => {
    const e = receipt.events[at++]; assert.ok(e && Object.keys(e).sort().join() === "args,key,kind,result,target");
    same([e.target, e.kind, e.key, e.args], [target, kind, key, args.map(encode)]); return decode(e.result);
  };
  const wrap = (id) => {
    const proxy = new Proxy({}, { get(_unused, key) {
      assert.equal(typeof key, "string");
      if (methods.includes(key)) return (...args) => call(id, "call", key, args);
      assert.ok(properties.includes(key)); return call(id, "get", key, []);
    } }); refs.set(proxy, id); return proxy;
  };
  let page = null, failure = null;
  try { page = runInNewContext(`(${snapshotMixedPage.toString()})({readPath})`, { URL, readPath: receipt.readPath,
    document: wrap(receipt.roots.document), location: wrap(receipt.roots.location), globalThis: wrap(receipt.roots.global),
    getComputedStyle: (el) => call(null, "style", "getComputedStyle", [el]) }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }); } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    failure = "native-dom-snapshot-failed";
  }
  assert.equal(at, receipt.events.length, "unused DOM source reads"); same(failure, receipt.failure);
  same(page === null ? null : JSON.parse(JSON.stringify(page)), receipt.page); return receipt.page;
}

export function retainJSONResponse(body, kind) {
  assert.ok(["state", "record"].includes(kind)); assert.ok(body.length <= 4 * 1024 ** 2);
  const text = body.toString("utf8"); assert.ok(Buffer.from(text).equals(body), "non-UTF8 public JSON");
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] ?? "x")) at++; };
  const string = () => { const start = at++; while (at < text.length) { const c = text[at++]; if (c === "\\") at++; else if (c === '"') return JSON.parse(text.slice(start, at)); } throw Error("invalid JSON string"); };
  const scan = (depth) => {
    assert.ok(depth < 32); ws(); if (text[at] === '"') { string(); return; }
    if (["[", "{"].includes(text[at])) {
      const object = text[at++] === "{", end = object ? "}" : "]", seen = new Set(); ws(); if (text[at] === end) { at++; return; }
      while (at < text.length) {
        if (object) { ws(); assert.equal(text[at], '"'); const key = string(); assert.ok(!seen.has(key), "duplicate public JSON member"); seen.add(key); ws(); assert.equal(text[at++], ":"); }
        scan(depth + 1); ws(); if (text[at] === end) { at++; return; } assert.equal(text[at++], ",");
      }
      throw Error("invalid JSON container");
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at)); assert.ok(token); at += token[0].length;
  }; scan(0); ws(); assert.equal(at, text.length);
  const value = JSON.parse(text);
  if (kind === "state") {
    assert.ok(Array.isArray(value) && value.length <= 1000);
    for (const row of value) {
      assert.ok(row && Object.keys(row).sort().join() === "email,item_id,target_minor");
      assert.match(row.email, /^[a-zA-Z0-9_.+@-]{1,254}$/); assert.match(row.item_id, /^item_\d+$/); assert.ok(Number.isSafeInteger(row.target_minor));
    }
  } else {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    same(Object.keys(value).sort(), ["id", "title", "subtitle", "description", "categories", "badges", "tags", "images", "fields", "summary", "listings", "offers", "contents", "included_in"].sort());
    const scalar = (val) => {
      assert.ok(val === null || ["string", "number", "boolean"].includes(typeof val));
      if (typeof val === "string") assert.ok(val.length <= 131072);
    };
    const object = (row, fields) => {
      assert.ok(row && typeof row === "object" && !Array.isArray(row)); same(Object.keys(row).sort(), fields.sort());
      Object.values(row).forEach(scalar);
    };
    for (const key of ["id", "title", "subtitle", "description"]) scalar(value[key]);
    for (const [key, fields] of Object.entries({ categories: ["name", "slug"], fields: ["name", "value"],
      listings: ["id", "seller", "rating_hundredths", "reviews", "condition", "ships_from", "quantity", "price_minor"], offers: ["id", "buyer", "condition", "quantity", "price_minor"],
      contents: ["id", "item_id", "title", "quantity"], included_in: ["id", "item_id", "title", "quantity"] })) {
      assert.ok(Array.isArray(value[key]) && value[key].length <= 1000); for (const row of value[key]) object(row, fields);
    }
    if (value.summary !== null) object(value.summary, ["lowest_minor", "count", "quantity"]);
    for (const key of ["badges", "tags", "images"]) assert.ok(Array.isArray(value[key]) && value[key].every((v) => typeof v === "string" && v.length <= 131072));
    for (const image of value.images) {
      const url = new URL(image, "http://native.invalid");
      assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
        && [...url.searchParams.values()].every((v) => !v), "unfilterable public image URL");
    }
  }
  return { kind, base64: body.toString("base64") };
}

export function parsePublicRecord(body) {
  retainJSONResponse(body, "record");
  return JSON.parse(body.toString("utf8"));
}

export function replayResponseEvidence(value, request, readSource) {
  const { evidence, row } = value;
  let complete = true;
  if (["completed", "rejected"].includes(row.outcome)) {
    const visible = evidence.stages.filter((s) => ["primary", "native-redirect"].includes(s.stage)).at(-1);
    if (request.category === "json" && !visible?.sourceBody) complete = false;
    if (request.category !== "json" && visible?.contentType === "text/html" && [200, 400, 422].includes(visible.status) && !evidence.domReads) complete = false;
  }
  for (const step of evidence.stages) if (step.stage.startsWith("state-") && step.status === 200 && step.contentType === "application/json" && !step.sourceBody) complete = false;
  for (const step of evidence.stages) if (Object.hasOwn(step, "sourceBody")) {
    assert.ok(step.sourceBody && typeof step.sourceBody === "object" && !Array.isArray(step.sourceBody));
    same(Object.keys(step.sourceBody).sort(), ["base64", "kind"]); assert.equal(typeof step.sourceBody.base64, "string");
    const body = Buffer.from(step.sourceBody.base64, "base64"); same(body.toString("base64"), step.sourceBody.base64);
    same([body.length, sha256(body)], [step.decodedBodyBytes, step.decodedBodySha256]);
    same(retainJSONResponse(body, step.sourceBody.kind), step.sourceBody);
  }
  if (row.record) {
    const primary = evidence.stages.find((s) => s.stage === "primary");
    if (!primary?.sourceBody) complete = false;
    else {
      assert.equal(primary.sourceBody.kind, "record");
      same(JSON.parse(Buffer.from(primary.sourceBody.base64, "base64")), row.record);
    }
  }
  if (row.page && !Object.hasOwn(evidence, "domReads")) {
    complete = false;
    if (Object.hasOwn(evidence, "domResponseSha256")) {
      const visible = evidence.stages.filter((s) => ["primary", "native-redirect"].includes(s.stage)).at(-1);
      same(evidence.domResponseSha256, visible?.decodedBodySha256);
    }
  }
  if (Object.hasOwn(evidence, "domReads")) {
    assert.ok(evidence.domReads && typeof evidence.domReads === "object" && !Array.isArray(evidence.domReads));
    const dom = evidence.domReads.path ? readSource(evidence.domReads, `response-sources/${evidence.domReads.sha256}.json`) : evidence.domReads;
    same(dom.readPath, request.formPage ?? request.path.split("?")[0]);
    const visible = evidence.stages.filter((s) => ["primary", "native-redirect"].includes(s.stage)).at(-1);
    same(evidence.domResponseSha256, visible.decodedBodySha256);
    if (dom.failure === "credential-filter-blocked") { same(row.page, null); complete = false; }
    else same(replayDOMReads(dom), row.page);
  }
  if (row.form) {
    assert.ok(evidence.nativeForm); same(bindNativeForm(request, evidence.nativeForm).evidence, row.form);
  }
  if (evidence.nativeFormDiscovery) {
    const discovery = evidence.stages.find((s) => s.stage === "form-discovery");
    same(evidence.nativeFormDiscovery.responseSha256, discovery.decodedBodySha256); assert.equal(typeof evidence.nativeFormDiscovery.found, "boolean");
    if (row.form) assert.equal(evidence.nativeFormDiscovery.found, true);
    if (row.outcome === "unsupported") assert.equal(evidence.nativeFormDiscovery.found, false);
  } else if (row.form || row.outcome === "unsupported") assert.fail("native form source observation missing");
  if (row.state) for (const [name, alerts] of [["before", row.state.before], ["after", row.state.after], ["readback", row.state.readback.alerts]]) {
    const step = evidence.stages.find((s) => s.stage === `state-${name}`);
    if (!step?.sourceBody) complete = false;
    else {
      assert.equal(step.sourceBody.kind, "state");
      same(JSON.parse(Buffer.from(step.sourceBody.base64, "base64")), alerts);
    }
  }
  return complete;
}
