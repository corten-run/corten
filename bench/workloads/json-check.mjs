// Native JSON correctness only. No browser, timing, qualification or cloud side effects.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { get } from "../catalog/check.mjs";
import { validateCatalog, validateRecord as catalogRecord } from "../catalog/contract.mjs";
import { validateMarketplace, validateRecord as marketplaceRecord } from "../marketplace/records.mjs";

export const jsonCheckSchema = "record-json-checks/v1";
const contracts = {
  "catalog-v1": { path: "catalog", validate: validateCatalog, record: catalogRecord, errors: [503] },
  "marketplace-v2": { path: "marketplace", validate: validateMarketplace, record: marketplaceRecord, errors: [302, 503] },
};

/**
 * Exercise native endpoints without borrowing another app's JSON row or requiring HTML.
 * Both payload contracts stay independent. `observe` must retain actual request/control
 * responses in the runner's raw evidence; it must not manufacture records from expectations.
 * Functional JSON cannot prove parse/reserialize rather than arbitrary byte manipulation.
 * Native serializer/source verification is separately required, regardless of wire formatting.
 * This result alone does not certify provenance, load readiness, budgets or a whole group.
 * Catalog's current upstream cannot inject redirects; that coverage limit is explicit.
 */
export async function checkJsonApp({ payload, base, records, source, upstream, observe }) {
  assert.ok(Object.hasOwn(contracts, payload), "unknown JSON payload contract");
  assert.ok(["fixture", "api"].includes(source), "unknown JSON source");
  assert.equal(typeof observe, "function", "raw response observer required");
  const contract = contracts[payload];
  contract.validate(records);
  const ids = Object.keys(records), first = ids[0];
  const route = (id) => `/api/${contract.path}/${encodeURIComponent(id)}`;
  const read = async (path) => {
    const response = await get(base + path);
    await observe({ kind: "application", method: "GET", path, ...response });
    return response;
  };
  const json = (response, expected, id) => {
    assert.equal(response.status, 200, `${payload} ${id}: JSON status`);
    assert.equal(response.type?.split(";")[0].trim().toLowerCase(), "application/json", "JSON content type required");
    const actual = JSON.parse(response.body);
    contract.record(actual, id);
    assert.deepEqual(actual, expected, `${payload} ${id}: complete typed record differs`);
  };
  const jsonError = (response) => {
    assert.ok(["application/json", "application/problem+json"].includes(response.type?.split(";")[0].trim().toLowerCase()), "JSON error representation required");
    JSON.parse(response.body);
  };
  const result = {
    schema: jsonCheckSchema, payload, source,
    recordsSha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
    jsonRecords: 0, missing: false, upstream: null, nativeSerializationVerified: false, readyForLoad: false,
    scope: "JSON functional checks only; native serializer/source verification, production qualification and measurement readiness remain required",
  };
  const controlPath = `/__${contract.path}/control`;
  const control = async (value) => {
    const response = await fetch(upstream + controlPath, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value), redirect: "manual", signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    await observe({ kind: "control", method: "POST", path: controlPath, value, status: response.status, body });
    assert.equal(response.status, 200, "upstream control failed");
  };
  const counters = async (expected, message) => {
    const response = await get(upstream + controlPath);
    await observe({ kind: "control", method: "GET", path: controlPath, ...response });
    assert.equal(response.status, 200, "upstream counter read failed");
    assert.deepEqual(JSON.parse(response.body).requests, expected, message);
  };
  const once = (id) => counters({ [id]: 1 }, "one request-time upstream read required");
  if (source === "api") assert.ok(upstream, "API checks require an owned upstream control URL");
  try {
    if (source === "api") await control({});
    let next = 0, failure;
    await Promise.all(Array.from({ length: 8 }, async () => {
      try {
        while (next < ids.length && !failure) {
          const id = ids[next++];
          json(await read(route(id)), records[id], id);
          result.jsonRecords++;
        }
      } catch (error) { failure ??= error; }
    }));
    if (failure) throw failure;
    assert.equal(result.jsonRecords, ids.length, "incomplete JSON record coverage");
    if (source === "api") {
      await counters(Object.fromEntries(ids.map((id) => [id, 1])), "complete record sweep requires one upstream read for every record");
      await control({});
    }
    // Find an absent ID in the contract's own ID space, not a special application route.
    let absent = `${first.split("_")[0]}_${ids.length + 1}`;
    while (Object.hasOwn(records, absent)) absent += "0";
    const missing = await read(route(absent));
    assert.equal(missing.status, 404, "unknown JSON record must return 404");
    jsonError(missing);
    result.missing = true;
    if (source === "api") {
      await once(absent);
      for (const version of [1, 2]) {
        const changed = { ...records[first], title: `${records[first].title} JSON upstream ${version}` };
        contract.record(changed, first);
        await control({ record: changed, pretty: true });
        const response = await read(route(first));
        json(response, changed, first);
        await once(first);
      }
      for (const status of contract.errors) {
        await control({ status });
        const response = await read(route(first));
        assert.ok(response.status >= 500 && response.status < 600, `upstream ${status} must not become successful JSON or a redirect`);
        jsonError(response);
        await once(first);
      }
      result.upstream = { readsPerRequest: 1, completeRecordSweep: true, uncachedJson: true,
        errorStatuses: [...contract.errors], redirectsTested: contract.errors.includes(302) };
    }
    return result;
  } finally { if (source === "api") await control({}); }
}
