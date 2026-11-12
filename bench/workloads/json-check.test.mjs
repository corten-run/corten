import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { records as catalogRecords } from "../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../marketplace/fixtures.mjs";
import { catalogServer } from "../catalog/upstream.mjs";
import { marketplaceServer } from "../marketplace/upstream.mjs";
import { checkJsonApp, jsonCheckSchema } from "./json-check.mjs";

const definitions = {
  "catalog-v1": { path: "catalog", records: catalogRecords, upstream: catalogServer },
  "marketplace-v2": { path: "marketplace", records: marketplaceRecords, upstream: marketplaceServer },
};
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}
// This is a deliberately small test adapter, not an implementation used for timing.
async function fixture(t, payload, source, fault = null) {
  const definition = definitions[payload], records = definition.records(), observed = [], paths = [];
  const instrumentation = { jsonParses: 0 };
  const upstreamServer = definition.upstream(records);
  const upstream = await listen(upstreamServer), cache = new Map();
  const app = createServer(async (req, res) => {
    paths.push(req.url);
    const prefix = `/api/${definition.path}/`, id = decodeURIComponent(req.url.slice(prefix.length));
    const send = (status, body, type = "application/json") => { res.writeHead(status, { "Content-Type": type }); res.end(body); };
    try {
      if (!req.url.startsWith(prefix)) return send(404, "{}");
      if (!Object.hasOwn(records, id) && source === "fixture") return send(fault === "missing" ? 200 : 404, "{}",
        fault === "html-error" ? "text/html" : fault === "error-suffix" ? "application/problem+json-seq" : "application/json");
      let record = records[id], raw;
      if (source === "api" && !(fault === "mostly-fixture" && id !== Object.keys(records)[0])) {
        if (fault === "cache" && cache.has(id)) record = cache.get(id);
        else {
          const response = await fetch(`${upstream}/${definition.path}/records/${encodeURIComponent(id)}`,
            { redirect: fault === "redirect" ? "follow" : "manual" });
          raw = await response.text();
          if (response.status === 404) return send(404, "{}");
          if (!response.ok) return send(fault === "swallow-error" ? 200 : 500,
            fault === "malformed-error" ? "not JSON" : JSON.stringify(records[id]), fault === "upstream-html" ? "text/html" : "application/json");
          if (["passthrough", "passthrough-newline"].includes(fault)) return send(200, raw + (fault === "passthrough-newline" ? "\n" : ""));
          instrumentation.jsonParses++;
          record = JSON.parse(raw);
          if (fault === "double-fetch") await (await fetch(`${upstream}/${definition.path}/records/${encodeURIComponent(id)}`)).arrayBuffer();
          if (fault === "cache") cache.set(id, record);
        }
      }
      if (fault === "schema") record = { ...record, unrequestedField: 1 };
      if (fault === "numeric" && record.summary) record = { ...record, summary: { ...record.summary, quantity: String(record.summary.quantity) } };
      const body = JSON.stringify(record, null, fault === "pretty" ? 2 : undefined);
      return send(200, body, fault === "html" ? "text/html" : fault === "suffix" ? "application/json-seq" : "application/json; charset=utf-8");
    } catch { send(500, "{}"); }
  });
  const base = await listen(app);
  t.after(async () => { await close(app); await close(upstreamServer); });
  return { payload, source, records, base, upstream, observe: (entry) => { observed.push(structuredClone(entry)); }, observed, paths, instrumentation };
}

for (const payload of Object.keys(definitions)) for (const source of ["fixture", "api"]) {
  test(`${payload} ${source}: complete native JSON work never requests a page`, async (t) => {
    const f = await fixture(t, payload, source), result = await checkJsonApp(f);
    assert.equal(result.schema, jsonCheckSchema);
    assert.equal(result.payload, payload); assert.equal(result.source, source);
    assert.equal(result.jsonRecords, Object.keys(f.records).length); assert.equal(result.missing, true);
    assert.equal(result.nativeSerializationVerified, false); assert.equal(result.readyForLoad, false);
    assert.match(result.recordsSha256, /^[a-f0-9]{64}$/);
    assert.ok(f.paths.every((path) => path.startsWith(`/api/${definitions[payload].path}/`)));
    const errorProbes = payload === "marketplace-v2" ? 2 : 1;
    assert.equal(f.observed.filter((entry) => entry.kind === "application").length,
      Object.keys(f.records).length + 1 + (source === "api" ? 2 + errorProbes : 0));
    if (source === "fixture") assert.equal(result.upstream, null);
    else {
      assert.equal(result.upstream.uncachedJson, true); assert.equal(result.upstream.completeRecordSweep, true);
      assert.equal(result.upstream.jsonReserialized, undefined);
      assert.equal(result.upstream.redirectsTested, payload === "marketplace-v2");
      const state = await (await fetch(`${f.upstream}/__${definitions[payload].path}/control`)).json();
      assert.deepEqual(state.requests, {}, "upstream controls restored after gate");
    }
  });
}

test("wrong schema, HTML masquerading as JSON and missing-item success fail closed", async (t) => {
  for (const [fault, message] of [["schema", /keys/], ["html", /JSON content type/],
    ["missing", /unknown JSON record/], ["html-error", /JSON error representation/],
    ["suffix", /JSON content type/], ["error-suffix", /JSON error representation/]]) {
    await t.test(fault, async (t) => assert.rejects(checkJsonApp(await fixture(t, "catalog-v1", "fixture", fault)), message));
  }
});

test("marketplace machine-numeric JSON cannot substitute localized or string numbers", async (t) => {
  await assert.rejects(checkJsonApp(await fixture(t, "marketplace-v2", "fixture", "numeric")), /bounded integer/);
});

test("API caching, fixture substitution, double reads and swallowed errors are rejected", async (t) => {
  for (const [fault, message] of [["cache", /complete typed record differs/], ["mostly-fixture", /complete record sweep/],
    ["double-fetch", /complete record sweep/], ["swallow-error", /must not become successful/], ["redirect", /one request-time/],
    ["upstream-html", /JSON error representation/], ["malformed-error", /JSON/]]) {
    await t.test(fault, async (t) => {
      const f = await fixture(t, "marketplace-v2", "api", fault);
      await assert.rejects(checkJsonApp(f), message);
      const state = await (await fetch(`${f.upstream}/__marketplace/control`)).json();
      assert.deepEqual(state.requests, {}, "even failed mutation/error probes reset controls");
    });
  }
});

test("wire formatting neither proves native serialization nor disqualifies a valid pretty serializer", async (t) => {
  for (const fault of ["pretty", "passthrough", "passthrough-newline"]) await t.test(fault, async (t) => {
    const f = await fixture(t, "catalog-v1", "api", fault), result = await checkJsonApp(f);
    assert.equal(result.jsonRecords, Object.keys(f.records).length);
    assert.equal(result.nativeSerializationVerified, false);
    assert.equal(result.readyForLoad, false);
    assert.equal(result.upstream.jsonReserialized, undefined);
    assert.ok(fault === "pretty" ? f.instrumentation.jsonParses > 0 : f.instrumentation.jsonParses === 0);
  });
});

test("payload/source identity, expected fixture and raw retention cannot be omitted", async (t) => {
  const f = await fixture(t, "catalog-v1", "fixture");
  for (const override of [{ payload: "legacy" }, { source: "memory" }, { observe: undefined }, { records: {} }]) {
    await assert.rejects(checkJsonApp({ ...f, ...override }));
  }
  assert.equal(f.paths.length, 0);
  await assert.rejects(checkJsonApp({ ...f, observe: () => { throw new Error("raw retention failed"); } }), /raw retention failed/);
});
