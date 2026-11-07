import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const record = {
  id: "record_1", title: '<script>&"', subtitle: "", description: "Plain text",
  tags: ["tag"], fields: [{ name: "Access", value: "North" }],
  related: [{ id: "record_2", title: "Other" }],
};
const source = new URL("./src/lib/server/catalog.ts", import.meta.url);

test("fixture is parsed on import and retained without reading per request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "catalog-test-"));
  const path = join(directory, "catalog.json");
  const previousSource = process.env.CATALOG_SOURCE;
  const previousPath = process.env.CATALOG_FIXTURE_PATH;
  try {
    await writeFile(path, JSON.stringify({ record_1: record }));
    process.env.CATALOG_SOURCE = "fixture";
    process.env.CATALOG_FIXTURE_PATH = path;
    const { fetchCatalogRecord, parseCatalogRecord } = await import(source.href + "?fixture");
    await rm(path);
    assert.deepEqual(await fetchCatalogRecord("record_1"), record);
    assert.equal(await fetchCatalogRecord("missing"), null);
    assert.deepEqual(parseCatalogRecord({ ...record, tags: [], fields: [], related: [] }),
      { ...record, tags: [], fields: [], related: [] });
    for (const invalid of [
      { ...record, title: 1 }, { ...record, tags: undefined },
      { ...record, fields: [{ name: "A", value: 2 }] },
      { ...record, related: [{ id: "x" }] },
    ]) assert.throws(() => parseCatalogRecord(invalid), /Invalid catalog record/);
  } finally {
    if (previousSource === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = previousSource;
    if (previousPath === undefined) delete process.env.CATALOG_FIXTURE_PATH;
    else process.env.CATALOG_FIXTURE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP fetches and parses once on every call, without caching or hiding failures", async () => {
  const previousSource = process.env.CATALOG_SOURCE;
  const previousBase = process.env.API_BASE;
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.CATALOG_SOURCE;
    process.env.API_BASE = "http://catalog.test";
    const { fetchCatalogRecord } = await import(source.href + "?http");
    let fetches = 0;
    let parses = 0;
    let status = 200;
    globalThis.fetch = async (url, options) => {
      fetches++;
      assert.equal(url, "http://catalog.test/catalog/records/record%2F1");
      assert.equal(options.cache, "no-store");
      return {
        status, ok: status === 200,
        json: async () => { parses++; return { ...record, title: String(fetches) }; },
      };
    };
    assert.equal((await fetchCatalogRecord("record/1")).title, "1");
    assert.equal((await fetchCatalogRecord("record/1")).title, "2");
    assert.equal(fetches, 2);
    assert.equal(parses, 2);
    status = 404;
    assert.equal(await fetchCatalogRecord("record/1"), null);
    status = 503;
    await assert.rejects(fetchCatalogRecord("record/1"), /catalog API returned 503/);
    assert.equal(parses, 2);
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("bad JSON"); } });
    await assert.rejects(fetchCatalogRecord("record/1"), /bad JSON/);
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ...record, tags: null }) });
    await assert.rejects(fetchCatalogRecord("record/1"), /Invalid catalog record/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSource === undefined) delete process.env.CATALOG_SOURCE;
    else process.env.CATALOG_SOURCE = previousSource;
    if (previousBase === undefined) delete process.env.API_BASE;
    else process.env.API_BASE = previousBase;
  }
});
