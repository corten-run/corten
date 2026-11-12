import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

const record = {
  id: "item_1", title: "A numeric record", subtitle: null, description: "Data",
  categories: [], badges: [], tags: [], images: [], fields: [], summary: null,
  listings: [], offers: [], contents: [], included_in: [],
};
let imports = 0;

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function withUpstream(handler, body) {
  const previousSource = process.env.MARKETPLACE_SOURCE, previousBase = process.env.API_BASE;
  const requests = [], closes = new Map(), timers = new Set();
  const server = createServer((request, response) => {
    const id = decodeURIComponent(request.url.split("/").at(-1));
    requests.push(request.url);
    closes.set(id, new Promise((resolve) => response.once("close", resolve)));
    handler(id, response, (callback, delay) => { timers.add(setTimeout(callback, delay)); });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    process.env.MARKETPLACE_SOURCE = "api";
    process.env.API_BASE = `http://127.0.0.1:${server.address().port}`;
    const { fetchMarketplaceRecord } = await import(`./lib/marketplace-server.ts?deadline-${imports++}`);
    await body(fetchMarketplaceRecord, requests, async (id) => {
      assert.ok(closes.has(id), "the upstream must have received the request");
      await within(closes.get(id), 2000, `${id}: upstream request remained open`);
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    const closing = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closing;
    if (previousSource === undefined) delete process.env.MARKETPLACE_SOURCE; else process.env.MARKETPLACE_SOURCE = previousSource;
    if (previousBase === undefined) delete process.env.API_BASE; else process.env.API_BASE = previousBase;
  }
}

test("one ten-second deadline cancels stalled headers and bodies, including late headers", async () => {
  await withUpstream((id, response, later) => {
    if (id === "headers") return;
    if (id === "body" || id === "late-headers") {
      const startBody = () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"id":');
      };
      if (id === "late-headers") later(startBody, 7000); else startBody();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(record));
  }, async (fetchRecord, requests, closed) => {
    const errors = await Promise.all(["headers", "body", "late-headers"].map(async (id) => {
      const started = performance.now();
      const error = await within(fetchRecord(id).then(() => assert.fail(`${id}: unexpected success`), (error) => error),
        12000, `${id}: read exceeded the ten-second deadline`);
      assert.ok(performance.now() - started >= 9500, `${id}: deadline fired too early`);
      assert.ok(["AbortError", "TimeoutError"].includes(error.name), `${id}: expected native abort, got ${error.name}`);
      await closed(id);
      return error;
    }));
    assert.equal(errors.length, 3);
    assert.deepEqual(await fetchRecord("item_1"), record, "a healthy read works after cancellations");
    assert.deepEqual(requests, ["headers", "body", "late-headers", "item_1"].map((id) => `/marketplace/records/${id}`));
  });
});

test("upstream errors and redirects preserve status semantics and cancel unread bodies", async () => {
  await withUpstream((id, response) => {
    response.writeHead(Number(id), { "Content-Type": "application/json", Location: "/must-not-follow" });
    response.write('{"unfinished":');
  }, async (fetchRecord, requests, closed) => {
    for (const status of [404, 301, 302, 303, 307, 308, 503]) {
      if (status === 404) assert.equal(await fetchRecord(String(status)), null);
      else await assert.rejects(fetchRecord(String(status)), new RegExp(`marketplace API returned ${status}`));
      await closed(String(status));
    }
    assert.deepEqual(requests, [404, 301, 302, 303, 307, 308, 503].map((status) => `/marketplace/records/${status}`));
  });
});

test("caller cancellation reaches stalled fetch and body consumption", async (t) => {
  await withUpstream((id, response) => {
    if (id === "body") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"id":');
    }
  }, async (fetchRecord, requests, closed) => {
    const nativeFetch = globalThis.fetch, bodyReading = Promise.withResolvers();
    t.mock.method(globalThis, "fetch", async (...args) => {
      const response = await nativeFetch(...args);
      const json = response.json.bind(response);
      response.json = () => { bodyReading.resolve(); return json(); };
      return response;
    });
    for (const id of ["headers", "body"]) {
      const controller = new AbortController();
      const pending = fetchRecord(id, controller.signal);
      // Wait until the real server has the request, rather than aborting only before fetch.
      for (let attempt = 0; !requests.includes(`/marketplace/records/${id}`) && attempt < 400; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(requests.includes(`/marketplace/records/${id}`), "upstream request did not start");
      if (id === "body") await within(bodyReading.promise, 2000, "JSON body consumption did not start");
      controller.abort();
      await within(assert.rejects(pending, { name: "AbortError" }), 2000, `${id}: caller abort did not stop the read`);
      await closed(id);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchRecord("pre-aborted", controller.signal), { name: "AbortError" });
    assert.equal(requests.length, 2, "an already-aborted caller starts no upstream request");
  });
});
