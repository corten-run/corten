// Lossless, content-addressed JSON pages. Binary response/source/tool blobs keep
// their existing byte identity; only structured observations use these nodes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const leafBytes = 16 * 1024, nodeBytes = 64 * 1024, width = 64, maxDepth = 96;
const maxLogical = 256 * 1024 ** 2, maxMaterial = 32 * 1024 ** 2, maxSlots = 1024 ** 2;
const size = (s) => Buffer.byteLength(s);

// A conservative upper bound permits native stringify only for a small packet.
// This avoids millions of generator yields for ordinary native receipt objects,
// without ever speculatively stringifying a journal, cell, app or whole run.
function packet(value, depth, ancestors) {
  let budget = leafBytes, values = 256, height = 0; const active = new Set(ancestors);
  const fits = (v, at) => {
    if (--values < 0 || at > maxDepth || budget < 0) return false;
    height = Math.max(height, at - depth);
    if (typeof v === "string") { budget -= 2 + v.length * 6; return budget >= 0; }
    if (v === null || ["undefined", "boolean", "number"].includes(typeof v)) { budget -= 24; return budget >= 0; }
    if (typeof v !== "object" || active.has(v)) return false;
    const array = Array.isArray(v);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
    if (array && v.length > 256) return false;
    active.add(v); budget -= 2;
    for (const key of array ? v.keys() : Object.keys(v)) {
      if (!array && v[key] === undefined) continue;
      budget -= 1 + (array ? 0 : 3 + key.length * 6);
      if (!fits(v[key], at + 1)) { active.delete(v); return false; }
    }
    active.delete(v); return budget >= 0;
  };
  return fits(value, depth) ? { text: JSON.stringify(value), height } : null;
}

function* stringParts(value) {
  yield '"';
  for (let at = 0; at < value.length;) {
    let end = Math.min(at + 2048, value.length);
    // JSON.stringify escapes a lone surrogate, but not a paired one. Do not
    // introduce a lone surrogate merely by splitting a string for hashing.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    yield JSON.stringify(value.slice(at, end)).slice(1, -1); at = end;
  }
  yield '"';
}

/** JSON.stringify's JSON-data semantics, without a whole-document string. */
export function* jsonParts(value, depth = 0, active = new Set(), cache = { values: new WeakMap(), bytes: 0 }) {
  assert.ok(depth <= maxDepth, "JSON record nesting exceeds bounds");
  if (typeof value === "string") { yield* stringParts(value); return; }
  if (value === null || typeof value !== "object") {
    assert.ok(value === null || ["number", "boolean", "undefined"].includes(typeof value), "Non-JSON evidence value");
    yield JSON.stringify(value ?? null); return;
  }
  assert.ok(!active.has(value), "Cyclic evidence JSON"); active.add(value);
  try {
    const array = Array.isArray(value);
    assert.ok(array || [Object.prototype, null].includes(Object.getPrototypeOf(value)), "Plain evidence JSON required");
    if (cache.values.has(value)) {
      const cached = cache.values.get(value); assert.ok(depth + cached.height <= maxDepth, "JSON record nesting exceeds bounds"); yield cached.text; return;
    }
    active.delete(value); const small = packet(value, depth, active); active.add(value);
    if (small !== null) {
      if (cache.bytes + small.text.length <= 1024 ** 2) { cache.values.set(value, small); cache.bytes += small.text.length; }
      yield small.text; return;
    }
    yield array ? "[" : "{"; let first = true;
    assert.ok(!array || value.length <= maxSlots, "JSON array exceeds bounds");
    for (const key of array ? value.keys() : Object.keys(value)) {
      if (!array && value[key] === undefined) continue;
      if (!first) yield ","; first = false;
      if (!array) { yield* stringParts(key); yield ":"; }
      yield* jsonParts(value[key], depth + 1, active, cache);
    }
    yield array ? "]" : "}";
  } finally { active.delete(value); }
}

export function updateJSON(hash, value) {
  let parts = [], length = 0;
  for (const part of jsonParts(value)) {
    parts.push(part); length += part.length;
    if (length >= 32 * 1024) { hash.update(parts.join("")); parts = []; length = 0; }
  }
  if (parts.length) hash.update(parts.join("")); return hash;
}
export function jsonSha256(value) { return updateJSON(createHash("sha256"), value).digest("hex"); }

export function encodeMetadata(value) {
  const chunks = []; let parts = [], length = 0, bytes = 1;
  const flush = () => { if (parts.length) chunks.push(Buffer.from(parts.join(""))); parts = []; length = 0; };
  for (const part of jsonParts(value)) {
    bytes += size(part); assert.ok(bytes <= maxMaterial, "Metadata JSON exceeds parser bounds");
    parts.push(part); length += part.length; if (length >= 32 * 1024) flush();
  }
  parts.push("\n"); flush(); return Buffer.concat(chunks, bytes);
}

function small(value) {
  const parts = []; let bytes = 0;
  for (const part of jsonParts(value)) {
    bytes += size(part); if (bytes > leafBytes) return null; parts.push(part);
  }
  return parts.join("");
}

export function writeJSON(value, blob, structured) {
  const active = new Set(), memo = new WeakMap(), pages = new Map();
  let material = 0;
  const node = (packet) => {
    const bytes = Buffer.from(JSON.stringify(packet) + "\n");
    assert.ok(bytes.length <= nodeBytes, "JSON record page exceeds bounds");
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (pages.has(hash)) return pages.get(hash).ref;
    material += bytes.length; assert.ok(material <= maxMaterial, "JSON record material exceeds bounds");
    const ref = blob(bytes); structured.add(ref.sha256); pages.set(hash, { ref, bytes }); return ref;
  };
  const combine = (kind, refs) => {
    while (refs.length > width) {
      const next = [];
      for (let i = 0; i < refs.length; i += width) next.push(node([kind, refs.slice(i, i + width)]));
      refs = next;
    }
    return node([kind, refs]);
  };
  const visit = (v, depth = 0) => {
    assert.ok(depth <= maxDepth && !active.has(v), "Cyclic/deep evidence record");
    if (v && typeof v === "object" && memo.has(v)) return memo.get(v);
    const text = small(v); let ref;
    if (text !== null) ref = node(["v", JSON.parse(text)]);
    else {
      active.add(v);
      try {
        if (Array.isArray(v)) {
          if (v.length === 1) ref = node(["l", [visit(v[0], depth + 1)]]);
          else if (v.length <= width) {
            const middle = Math.ceil(v.length / 2);
            ref = node(["a", [visit(v.slice(0, middle), depth + 1), visit(v.slice(middle), depth + 1)]]);
          }
          else {
            const refs = [];
            for (let i = 0; i < v.length; i += width) refs.push(visit(v.slice(i, i + width), depth + 1));
            ref = combine("a", refs);
          }
        } else if (typeof v === "string") {
          const refs = [];
          for (let i = 0; i < v.length; i += 2048) refs.push(visit(v.slice(i, i + 2048), depth + 1));
          ref = combine("s", refs);
        } else ref = node(["o", Object.keys(v).filter((key) => v[key] !== undefined).map((key) => [key, visit(v[key], depth + 1)])]);
      } finally { active.delete(v); }
    }
    if (v && typeof v === "object") memo.set(v, ref);
    return ref;
  };
  const ref = visit(value);
  // Apply the very same logical/materialization bounds before accepting a
  // producer root. Repeated references cannot smuggle an expansion bomb into a
  // sealed run that its own saved reader would be unable to replay.
  readJSON(ref, (r) => {
    const page = pages.get(r.sha256);
    assert.ok(page && r.path === page.ref.path && r.bytes === page.ref.bytes, "Invalid producer page reference"); return page.bytes;
  }, structured, (bytes) => JSON.parse(bytes.toString("utf8")));
  return ref;
}

/** A fresh cache per root, never a cache of the complete run's hydrated cells. */
export function readJSON(ref, read, structured, parse) {
  const cache = new Map(), active = new Set(); let material = 0, slots = 0;
  const visit = (ref, depth = 0) => {
    assert.ok(depth <= maxDepth && structured.has(ref.sha256) && !active.has(ref.sha256), "Invalid/cyclic JSON record reference");
    // Validate even cached aliases: a caller cannot change the path/length of a
    // previously decoded hash and avoid reference validation.
    const cached = cache.get(ref.sha256);
    if (cached) {
      assert.ok(Object.keys(ref).length === 3 && ref.path === cached.ref.path && ref.bytes === cached.ref.bytes, "Aliased JSON record reference differs");
      assert.ok(depth + cached.height <= maxDepth, "JSON record nesting exceeds bounds");
      return cached;
    }
    assert.ok(ref.bytes <= nodeBytes, "Oversized JSON record page");
    const bytes = read(ref);
    material += bytes.length;
    assert.ok(bytes.length <= nodeBytes && material <= maxMaterial, "JSON record material exceeds bounds");
    const packet = parse(bytes);
    assert.ok(Array.isArray(packet) && packet.length === 2 && typeof packet[0] === "string", "Malformed JSON record node");
    const [kind, body] = packet;
    active.add(ref.sha256); let value, logical, height = 0;
    try {
      if (kind === "v") {
        logical = size(JSON.stringify(body)); assert.ok(logical <= leafBytes, "Oversized JSON value page"); value = body;
        const count = (v, nesting = depth) => {
          assert.ok(nesting <= maxDepth, "JSON record nesting exceeds bounds");
          height = Math.max(height, nesting - depth);
          if (v === null || typeof v !== "object") return;
          slots += Object.keys(v).length; assert.ok(slots <= maxSlots, "JSON record slots exceed bounds");
          for (const child of Object.values(v)) count(child, nesting + 1);
        };
        count(body);
      } else {
        assert.ok(Array.isArray(body), "Malformed JSON record edges");
        slots += body.length; assert.ok(slots <= maxSlots, "JSON record slots exceed bounds");
        if (kind === "o") {
          value = {}; logical = 2; const seen = new Set();
          for (const [i, pair] of body.entries()) {
            assert.ok(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && !seen.has(pair[0]), "Duplicate/malformed JSON object member");
            const [key, child] = pair, decoded = visit(child, depth + 1); seen.add(key);
            height = Math.max(height, 1 + decoded.height);
            logical += (i ? 1 : 0) + size(JSON.stringify(key)) + 1 + decoded.logical;
            assert.ok(logical <= maxLogical, "Expanded JSON record exceeds bounds");
            Object.defineProperty(value, key, { value: decoded.value, enumerable: true, configurable: true, writable: true });
          }
        } else if (kind === "s") {
          const strings = []; let length = 0;
          for (const child of body) {
            const decoded = visit(child, depth + 1); assert.equal(typeof decoded.value, "string");
            height = Math.max(height, 1 + decoded.height);
            length += decoded.value.length; assert.ok(length <= maxMaterial / 2, "Expanded JSON string exceeds bounds"); strings.push(decoded.value);
          }
          value = strings.join(""); logical = 0; for (const part of stringParts(value)) logical += size(part);
        } else {
          assert.ok(kind === "l" || kind === "a", "Unknown JSON record node");
          value = []; logical = 2;
          for (const child of body) {
            const decoded = visit(child, depth + 1), values = kind === "a" ? decoded.value : [decoded.value];
            height = Math.max(height, 1 + decoded.height);
            assert.ok(Array.isArray(values), "JSON array page required");
            const added = kind === "a" ? decoded.logical - 2 : decoded.logical;
            logical += added + (value.length && values.length ? 1 : 0);
            slots += values.length;
            assert.ok(logical <= maxLogical && slots <= maxSlots, "Expanded JSON array exceeds bounds");
            for (const item of values) value.push(item);
          }
        }
      }
    } finally { active.delete(ref.sha256); }
    assert.ok(logical <= maxLogical, "Expanded JSON record exceeds bounds");
    const result = { value, logical, height, ref }; cache.set(ref.sha256, result); return result;
  };
  return visit(ref).value;
}
