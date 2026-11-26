import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createProviderEngine as providerTransport, isSettledAccountFailure, isSettledCatalogFailure } from "./cloud-engine-test-fixture.mjs";
import { providerTransport as workerTransport } from "./cloud-provider.mjs";
import { context, harness, syntheticPlacement } from "./cloud-fixtures.mjs";
import { fleetCatalogCommand, fleetRegion, preloginUserData, tags } from "./cloud-contract.mjs";

const credential = "SYNTHETIC_ONLY_CREDENTIAL_A";
const account = ["account", "get", "--output", "json", "--context", context];
const list = ["compute", "droplet", "list", "--output", "json", "--context", context];
const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
  "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", "--context", context];
const empty = { status: 200, value: { droplets: [], meta: { total: 0 }, links: {} } };
const spawn = () => ({ status: 0, stdout: Buffer.from(`${credential}\n`), stderr: Buffer.alloc(0) });

// Projection of the fields consulted by create, not a captured provider trace:
// https://github.com/digitalocean/openapi/blob/998192821fe95ee79e41f577933601d009179dcf/specification/resources/droplets/responses/examples.yml
// Source key: droplet_create_response. Action reads below are synthetic instances
// of resources/actions/models/action.yml at the same revision, with linked IDs.
const publishedCreate = () => ({ status: 202, value: { droplet: { id: 3164444, status: "new", networks: { v4: [], v6: [] } },
  links: { actions: [{ id: 7515, rel: "create", href: "https://api.digitalocean.com/v2/actions/7515" }] } } });
const createAction = (status = "completed", resource_id = 3164444) => ({ status: 200, value: {
  action: { id: 7515, type: "create", resource_type: "droplet", resource_id, status } } });

test("provider engine refuses cross-mode or unbound create before consuming credentials", async () => {
  const legacy = create.with(7, "sfo2");
  for (const [createMode, args] of [["legacy", create], ["dedicated", legacy], [null, create],
    ["dedicated-lon1", create.with(7, "blr1")], ["dedicated-blr1", create.with(7, "nyc1")]]) {
    let consumes = 0, requests = 0;
    const run = providerTransport({ repo: resolve("."), createMode,
      spawn() { consumes++; return spawn(); }, request() { requests++; return empty; } });
    await assert.rejects(run(args, 60000, true), /placement differs from authorized mode/);
    assert.equal(consumes, 0); assert.equal(requests, 0);
  }
});

test("only a dedicated create sends fixed prelogin data; no command supplies user data", async () => {
  for (const [mode, args] of [["dedicated", create], ["legacy", create.with(7, "sfo2")]]) {
    const posts = [];
    const run = providerTransport({ repo: resolve("."), createMode: mode, spawn, request({ method, body }) {
      if (method === "POST") { posts.push(body); return publishedCreate(); }
      return createAction();
    } });
    await assert.rejects(run([...args.slice(0, -2), "--user-data", "unreviewed", ...args.slice(-2)], 60000));
    assert.deepEqual(posts, []);
    await run(args, 60000);
    assert.equal(posts.length, 1);
    if (mode === "legacy") assert.ok(!Object.hasOwn(posts[0], "user_data"));
    else assert.equal(posts[0].user_data, preloginUserData);
  }
});

test("placement catalog uses bounded fixed GETs, projects facts and rejects incomplete or foreign pages", async () => {
  const command = [...fleetCatalogCommand, "--context", context];
  for (const mode of ["complete", "foreign-next", "missing-page", "changed-count", "duplicate"]) {
    const calls = [], { sizes, regions } = syntheticPlacement(["sfo2"]);
    const first = { sizes: [{ ...sizes[0], price: credential }], meta: { total: 2 }, links: {
      pages: { next: mode === "foreign-next" ? `https://foreign.invalid/${credential}` : "https://api.digitalocean.com/v2/sizes?page=2&per_page=200" },
    } };
    if (mode === "missing-page") delete first.links;
    const run = providerTransport({ repo: resolve("."), createMode: null, spawn, request({ method, path, body, credential: token }) {
      assert.equal(method, "GET"); assert.equal(body, undefined); assert.equal(token, credential);
      calls.push(path);
      if (path === "/v2/sizes?page=1&per_page=200") return { status: 200, value: first };
      if (path === "/v2/sizes?page=2&per_page=200") return { status: 200, value: {
        sizes: [mode === "duplicate" ? sizes[0] : sizes[1]], meta: { total: mode === "changed-count" ? 3 : 2 },
      } };
      assert.equal(path, "/v2/regions?page=1&per_page=200");
      return { status: 200, value: { regions, meta: { total: regions.length } } };
    } });
    if (mode === "complete") assert.deepEqual(JSON.parse((await run(command)).stdout), { sizes, regions });
    else await assert.rejects(run(command), { providerDiagnostic: { code: "catalog-response" } });
    assert.deepEqual(calls, ["/v2/sizes?page=1&per_page=200",
      ...(["foreign-next", "missing-page"].includes(mode) ? [] : ["/v2/sizes?page=2&per_page=200"]),
      ...(mode === "complete" ? ["/v2/regions?page=1&per_page=200"] : [])]);
  }
});

test("placement catalog retains both directions for supported candidates and drops unlisted regions", async () => {
  const sizes = [
    { slug: "c-8", available: true, regions: ["nyc1", "blr1", "lon1"] },
    { slug: "c-16", available: true, regions: ["sfo2"] },
    { slug: "c-32", available: true, regions: ["sfo2"] },
    { slug: "c-4", available: true, regions: ["lon1"] },
  ];
  const regions = [
    { slug: "sfo3", available: true, sizes: [] },
    { slug: "sfo2", available: true, sizes: ["c-16", "c-32"] },
    { slug: "lon1", available: true, sizes: ["c-8", "c-4"] },
    { slug: "blr1", available: true, sizes: ["c-8"] },
    { slug: "nyc1", available: true, sizes: ["c-8"] },
  ];
  const calls = [];
  const run = providerTransport({ repo: resolve("."), createMode: null, spawn, request({ method, path, body }) {
    assert.equal(method, "GET"); assert.equal(body, undefined); calls.push(path);
    if (path === "/v2/sizes?page=1&per_page=200") return { status: 200, value: { sizes, meta: { total: sizes.length } } };
    assert.equal(path, "/v2/regions?page=1&per_page=200");
    return { status: 200, value: { regions, meta: { total: regions.length } } };
  } });
  const result = await run([...fleetCatalogCommand, "--context", context]);
  assert.deepEqual(JSON.parse(result.stdout), {
    sizes: [{ ...sizes[0], regions: ["lon1", "blr1"] }, sizes[1], sizes[2]],
    regions: [regions[0], regions[1], { ...regions[2], sizes: ["c-8"] }, regions[3]],
  });
  assert.deepEqual(calls, ["/v2/sizes?page=1&per_page=200", "/v2/regions?page=1&per_page=200"]);
});

test("an unusable optional c-32 offer does not hide default, catalog or c-16 placements", async () => {
  for (const row of [
    { slug: "c-32", available: true },
    { slug: "c-32", available: true, regions: [null] },
    { slug: "c-32", available: "true", regions: ["sfo2"] },
  ]) {
    const { sizes, regions } = syntheticPlacement();
    sizes.push(row);
    regions.find((entry) => entry.slug === "sfo2").sizes.push("c-32");
    const run = providerTransport({ repo: resolve("."), createMode: null, spawn, request({ method, path }) {
      assert.equal(method, "GET");
      const kind = path === "/v2/sizes?page=1&per_page=200" ? "sizes" : "regions";
      assert.equal(path, `/v2/${kind}?page=1&per_page=200`);
      const rows = kind === "sizes" ? sizes : regions;
      return { status: 200, value: { [kind]: rows, meta: { total: rows.length } } };
    } });
    const projected = JSON.parse((await run([...fleetCatalogCommand, "--context", context])).stdout);
    for (const mode of [{ group: "json-api" }, { group: "catalog-page" },
      { group: "json-api", loadLayout: "json-c16-generator-v1" }]) {
      assert.equal(fleetRegion(projected, "sfo3", { staged: true, ...mode }), "sfo3");
    }
    assert.throws(() => fleetRegion(projected, "sfo3", { staged: true, group: "json-api", loadLayout: "json-c32-generator-v1" }),
      /missing or invalid fleet catalog entry: c-32/);
  }
});

test("create-link diagnostics isolate each refused predicate without reflecting provider values", async (t) => {
  const cases = [
    ["shape", (response) => { response.value.links.actions = { raw: credential }; }],
    ["count", (response) => { response.value.links.actions = []; }],
    ["id", (response) => { response.value.links.actions[0].id = credential; }],
  ];
  for (const [predicate, mutate] of cases) await t.test(predicate, async () => {
    const response = publishedCreate(), calls = []; mutate(response);
    const run = providerTransport({ repo: resolve("."), spawn, request({ method, path }) {
      calls.push({ method, path }); return response;
    } });
    const result = await run(create, 1000, true);
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
    assert.deepEqual(result.providerDiagnostic, { code: `create-link-${predicate}`, ...(predicate === "href" ? { detail: "foreign-origin" } : {}) });
    assert.ok(!JSON.stringify(result).includes(credential));
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" }]);
  });
});

const advisoryHints = [
  { rel: "delete", href: `https://${credential}@foreign.invalid/private#${credential}` },
  {}, { rel: "create", href: "https://api.digitalocean.com/v2/actions/7515" },
  { rel: "delete", href: "https://api.digitalocean.com/v2/droplets/3164445/actions/7516" },
  { rel: null, href: null }, { rel: 17, href: 42 }, { rel: false, href: true },
  { rel: { raw: credential }, href: [null, { raw: credential }] },
  { rel: credential, href: `https://${credential}@foreign.invalid/private#${credential}` },
  { rel: [], href: "not a URL" }, { href: "/v2/actions/7515" },
  { href: "https://api.digitalocean.com:443/v2/actions/7515?next=1" },
];

test("create metadata noninterference projects only IDs and makes identical canonical requests", async () => {
  for (const hints of advisoryHints) {
    const response = publishedCreate(), calls = []; let clock = 0;
    response.value.links.actions[0] = { id: 7515, ...hints };
    response.value.droplet.unused = { raw: credential };
    const run = providerTransport({ repo: resolve("."), spawn, now: () => clock,
      sleep: async (ms) => { clock += ms; }, request(options) {
        assert.ok(!JSON.stringify({ ...options, credential: undefined }).includes(credential));
        const { method, path, timeout } = options; calls.push({ method, path, timeout });
        return method === "POST" ? response : createAction(clock ? "completed" : "in-progress", clock ? 3164444 : null);
      } });
    const result = await run(create, 5000);
    assert.deepEqual(result, { status: 0, stdout: '[{"id":3164444}]', stderr: "" });
    assert.ok(!JSON.stringify(result).includes(credential));
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets", timeout: 5000 },
      { method: "GET", path: "/v2/actions/7515", timeout: 5000 }, { method: "GET", path: "/v2/actions/7515", timeout: 4000 }]);
  }
});

test("create projection does not even read advisory rel or href properties", async () => {
  const response = publishedCreate(), calls = [];
  for (const key of ["rel", "href"]) Object.defineProperty(response.value.links.actions[0], key, {
    get() { assert.fail(`unused ${key} must not be read`); }, enumerable: true,
  });
  const run = providerTransport({ repo: resolve("."), spawn, request({ method, path }) {
    calls.push({ method, path }); return method === "POST" ? response : createAction();
  } });
  assert.deepEqual(await run(create, 1000), { status: 0, stdout: '[{"id":3164444}]', stderr: "" });
  assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" }, { method: "GET", path: "/v2/actions/7515" }]);
});

test("positive safe-integer droplet and action IDs keep their exact canonical identity", async () => {
  for (const id of [1, 3_000_000_001, Number.MAX_SAFE_INTEGER]) {
    const response = publishedCreate(), action = createAction(), calls = [];
    response.value.droplet.id = id; response.value.links.actions[0] = { id };
    action.value.action.id = id; action.value.action.resource_id = id;
    const run = providerTransport({ repo: resolve("."), spawn, request({ method, path }) {
      calls.push({ method, path }); return method === "POST" ? response : action;
    } });
    assert.deepEqual(await run(create, 1000), { status: 0, stdout: JSON.stringify([{ id }]), stderr: "" });
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" }, { method: "GET", path: `/v2/actions/${id}` }]);
  }
});

test("controller joins successful create ID to fresh ownership before provisioning", async (t) => {
  const cases = [
    { createReturnedId: 124 },
    ...["", "not JSON", "null", "{}", "[]", '[{"id":123},{"id":123}]', '[{"id":"123"}]',
      '[{}]', '[{"id":null}]', '[{"id":0}]', '[{"id":-1}]', '[{"id":1.5}]', '[{"id":9007199254740992}]']
      .map((createStdout) => ({ createStdout })),
  ];
  for (const flags of cases) await t.test(JSON.stringify(flags), async (t) => {
    const h = harness(t, flags);
    await assert.rejects(h.launch().launch());
    assert.equal(h.saved().id, "123"); assert.equal(h.saved().status, "preparing");
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
    assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
    await assert.rejects(h.launch().launch()); assert.equal(h.creates, 1);
  });
});

test("mismatched create identity retains owned host for unused cleanup without create replay", async (t) => {
  const h = harness(t, { createReturnedId: 124, missingUnit: true });
  await assert.rejects(h.launch().launch());
  assert.equal(h.saved().id, "123"); assert.equal(h.saved().status, "preparing");
  assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
  assert.equal(await h.pinnedUnused().collect(), 1);
  assert.equal(h.saved().status, "retired"); assert.ok(h.saved().destroyedAt);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 1);
});

const censusPage = (droplets, total, page) => ({ status: 200, value: { droplets, meta: { total }, links: page === undefined ? {}
  : { pages: { next: `https://api.digitalocean.com/v2/droplets?page=${page}&per_page=200` } } } });
function censusFixture(steps) {
  const state = { clock: 0, cancelled: false, checkpointCost: 0 }, calls = [];
  const run = providerTransport({ repo: resolve("."), spawn, now: () => state.clock, interrupted: () => {
    state.clock += state.checkpointCost; state.checkpointCost = 0; return state.cancelled;
  }, sleep: async (ms) => { state.clock += ms; }, request({ method, path, timeout }) {
    assert.equal(method, "GET"); assert.ok(path.startsWith("/v2/droplets?"));
    const step = steps[calls.length]; assert.ok(step, "no unexpected census request"); calls.push({ path, timeout });
    state.clock += step.cost ?? 0; state.checkpointCost = step.checkpointCost ?? 0;
    state.cancelled = step.cancel === true;
    if (step.transport) throw new Error("PRIVATE_FAKE_REQUEST");
    return step.response;
  } });
  return { run, calls, state };
}
const censusFailure = (error) => error.providerDiagnostic?.code === "list-response-count";

test("census predicate diagnostics isolate refusals without reflecting provider values", async (t) => {
  const response = (value) => ({ status: 200, value });
  const cases = [
    ["shape", response(null)], ["shape", response({ droplets: { raw: credential } })],
    ["bounds", censusPage(Array.from({ length: 201 }, (_, i) => ({ id: i + 1 })), 201)],
    ...[undefined, null, credential, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((total) => ["total", censusPage([], total)]),
    ["bounds", censusPage([], 20001)],
    ...[undefined, null, credential, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((id) => ["id", censusPage([{ id }], 1)]),
    ["duplicate", censusPage([{ id: 1 }, { id: 1 }], 2)],
    ...[null, [], credential].map((links) => ["links", response({ droplets: [], meta: { total: 0 }, links })]),
    ...[null, [], credential].map((pages) => ["pages", response({ droplets: [], meta: { total: 0 }, links: { pages } })]),
    ...[null, 2, credential, `https://foreign.invalid/${credential}`, "https://api.digitalocean.com/v2/droplets?page=2",
      "https://api.digitalocean.com/v2/droplets?page=2&per_page=20", "https://api.digitalocean.com/v2/droplets?page=3&per_page=200",
      "https://api.digitalocean.com/v2/droplets?page=2&page=2&per_page=200", "https://api.digitalocean.com/v2/droplets?page=2&per_page=200&raw=1",
      "https://user:password@api.digitalocean.com/v2/droplets?page=2&per_page=200", "https://api.digitalocean.com/v2/other?page=2&per_page=200",
      "https://api.digitalocean.com/v2/droplets?page=2&per_page=200#fragment"].map((next) =>
      ["next", response({ droplets: [], meta: { total: 1 }, links: { pages: { next } } })]),
    ["bounds", censusPage([{ id: 1 }], 1, 2)],
  ];
  for (const [i, [predicate, value]] of cases.entries()) await t.test(`${predicate}-${i}`, async () => {
    const h = censusFixture([{ response: value }]);
    await assert.rejects(h.run(list, 1000, true), (error) => {
      assert.deepEqual(error.providerDiagnostic, { code: `list-response-${predicate}` });
      assert.equal(error.controlUncertain, undefined);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(credential)); return true;
    });
    assert.equal(h.calls.length, 1, "malformed data never dispatches a retake");
  });
  for (const [predicate, steps] of [
    ["duplicate", [censusPage([{ id: 1 }], 2, 2), censusPage([{ id: 1 }], 3)]],
    ["count", Array.from({ length: 100 }, () => censusPage([{ id: 1 }], 2))],
    ["count", Array.from({ length: 100 }, (_, i) => i % 2 === 0 ? censusPage([{ id: 1 }], 2, 2) : censusPage([{ id: 2 }], 3))],
  ]) await t.test(`${predicate}-${steps.length}-GETs`, async () => {
    const h = censusFixture(steps.map((value) => ({ response: value })));
    await assert.rejects(h.run(list, 200000), (error) => error.providerDiagnostic?.code === `list-response-${predicate}`);
    assert.equal(h.calls.length, steps.length);
  });
});

test("census predicate diagnostics never replace coarse deadline or cancellation phases", async () => {
  for (const [code, cancel] of [["list-response", false], ["provider-output", false], ["list-response", true]]) {
    let clock = 0, cancelled = false, requests = 0, boundaryReached = false;
    const stop = () => { boundaryReached = true; if (cancel) cancelled = true; else clock = 1000; };
    const response = censusPage([{ id: 1 }], 1);
    // Synthetic data hooks stop at validation or serialization, not at an
    // incidental ordinal clock read (including credential budget samples).
    if (code === "list-response") Object.defineProperty(response.value.links, "pages", { get() { stop(); return undefined; } });
    else response.value.droplets[0].toJSON = () => { stop(); return { id: 1 }; };
    const run = providerTransport({ repo: resolve("."), spawn, now: () => clock,
      interrupted: () => cancelled, request() { requests++; return response; } });
    await assert.rejects(run(list, 1000), (error) => {
      assert.deepEqual(error.providerDiagnostic, { code }); assert.equal(error.controlUncertain, true); return true;
    });
    assert.equal(boundaryReached, true);
    assert.equal(requests, 1);
  }
  const h = censusFixture([{ response: censusPage([], 1), cost: 400 }, { response: censusPage([], 0), cost: 600 }]);
  await assert.rejects(h.run(list, 2000), (error) => error.providerDiagnostic?.code === "list-request" && error.controlUncertain === true);
  assert.equal(h.calls.length, 2);
});

test("census retakes only a count mismatch as a fresh complete page1 under the original deadline", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
  const h = censusFixture([{ response: censusPage(rows, 10), cost: 400 }, { response: censusPage(rows, 7), cost: 300 }]);
  const result = JSON.parse((await h.run(list, 3000)).stdout);
  assert.ok(isDeepStrictEqual(result, rows), "only the complete new census is returned");
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0].timeout, 3000); assert.equal(h.calls[1].timeout, 1600);
  assert.equal(h.calls[1].path, "/v2/droplets?page=1&per_page=200"); assert.equal(h.state.clock, 1700);
});

test("census changed total discards every old page, ID and total before a retake", async () => {
  const first = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })), stable = [{ id: 1 }, { id: 701 }];
  const h = censusFixture([{ response: censusPage(first, 201, 2), cost: 400 },
    { response: censusPage([{ id: 201 }, { id: 202 }], 202), cost: 300 }, { response: censusPage(stable, 2), cost: 200 }]);
  const result = JSON.parse((await h.run(list, 3000)).stdout);
  assert.ok(isDeepStrictEqual(result, stable), "no old census row, seen ID or total may carry over");
  assert.equal(h.calls.length, 3); assert.equal(h.calls[2].timeout, 1300);
  assert.equal(h.calls[2].path, "/v2/droplets?page=1&per_page=200");
});

test("census persistent mismatch refuses at the shared100GET bound instead of accepting partial rows", async () => {
  const h = censusFixture(Array.from({ length: 100 }, () => ({ response: censusPage([], 1) })));
  await assert.rejects(h.run(list, 200000), censusFailure); assert.equal(h.calls.length, 100);
});

test("census malformed IDs, totals and links outrank a simultaneous count or total change", async () => {
  const second = [["duplicate", censusPage([{ id: 1 }], 3)], ["id", censusPage([{ id: "PRIVATE_ID" }], 3)], ["total", censusPage([], "PRIVATE_TOTAL")],
    ["total", censusPage([], -1)], ["bounds", censusPage([], 20001)], ["next", censusPage([], 1, 1)], ["next", censusPage([], 3, 4)],
    ["links", { status: 200, value: { droplets: [], meta: { total: 3 }, links: null } }],
    ["pages", { status: 200, value: { droplets: [], meta: { total: 3 }, links: { pages: [] } } }],
    ["next", { status: 200, value: { droplets: [], meta: { total: 3 }, links: { pages: { next: "https://synthetic.invalid/v2/droplets?page=3&per_page=200" } } } }]];
  for (const [predicate, response] of second) {
    const h = censusFixture([{ response: censusPage([{ id: 1 }], 2, 2) }, { response }]);
    await assert.rejects(h.run(list), (error) => error.providerDiagnostic?.code === `list-response-${predicate}` && !JSON.stringify(error).includes("PRIVATE"));
    assert.equal(h.calls.length, 2, "malformed data must not reach another page1");
  }
});

test("census retains one global100GET ceiling across both complete attempts", async () => {
  const steps = Array.from({ length: 99 }, (_, i) => ({ response: censusPage([{ id: i + 1 }], 20000, i === 98 ? undefined : i + 2) }));
  steps.push({ response: censusPage([{ id: 999 }], 2, 2) });
  const h = censusFixture(steps);
  await assert.rejects(h.run(list), (error) => error.providerDiagnostic?.code === "list-response-bounds"); assert.equal(h.calls.length, 100);
  assert.equal(h.calls[99].path, "/v2/droplets?page=1&per_page=200");
});

test("census complete second attempt may finish on the exact global100th GET", async () => {
  const steps = [{ response: censusPage([], 1) }, ...Array.from({ length: 99 }, (_, i) => ({
    response: censusPage([{ id: i + 1 }], 99, i === 98 ? undefined : i + 2) }))];
  const h = censusFixture(steps);
  assert.equal(JSON.parse((await h.run(list)).stdout).length, 99); assert.equal(h.calls.length, 100);
});

test("census deadline includes response/checkpoint cost and refuses equality, overshoot and reverse time", async () => {
  for (const step of [
    { response: censusPage([], 0), cost: 1000 }, { response: censusPage([], 0), cost: 1001 },
    { response: censusPage([], 1), cost: 400, checkpointCost: 600 }, { response: censusPage([], 1), cost: -1 },
  ]) {
    const h = censusFixture([step]);
    await assert.rejects(h.run(list, 1000), (error) => error.controlUncertain === true);
    assert.equal(h.calls.length, 1, "expired or reversed proof cannot dispatch a retake");
  }
});

test("census retake never retries HTTP, request errors or cancellation", async () => {
  for (const [step, code] of [[{ response: { status: 429, value: null } }, "list-http"],
    [{ transport: true }, "list-request"], [{ response: censusPage([], 1), cancel: true }, "list-request"]]) {
    const h = censusFixture([step]);
    await assert.rejects(h.run(list, 1000), (error) => error.providerDiagnostic?.code === code);
    assert.equal(h.calls.length, 1);
  }
});

test("census second request failure or cancellation never dispatches another retake", async () => {
  for (const step of [{ transport: true }, { response: { status: 500, value: null } }, { response: censusPage([], 0), cancel: true }]) {
    const h = censusFixture([{ response: censusPage([], 1) }, step]);
    await assert.rejects(h.run(list, 3000)); assert.equal(h.calls.length, 2);
  }
});

test("census retake deducts checkpoint time before the next native grant", async () => {
  const h = censusFixture([{ response: censusPage([], 1), cost: 200, checkpointCost: 300 }, { response: censusPage([], 0), cost: 100 }]);
  assert.equal(JSON.parse((await h.run(list, 3000)).stdout).length, 0);
  assert.equal(h.calls[1].timeout, 1500); assert.equal(h.state.clock, 1600);
});

function censusWorker(t, mode, host = null) {
  const root = mkdtempSync(join(tmpdir(), "census-worker-test-")), entry = join(root, "entry.mjs"), output = join(root, "counts.json");
  const heapOptions = "--max-old-space-size=64 --max-semi-space-size=4";
  // Test-only bootstrap consumes an exact harmless heap limit at Node startup,
  // then removes that test option from env before the unchanged worker checks.
  // It tests real handler/engine IPC, not the production stdin bootstrap entry.
  writeFileSync(entry, `import assert from 'node:assert/strict';
    import {writeFileSync} from 'node:fs'; import {getHeapStatistics} from 'node:v8';
    import {serveProviderWorker} from ${JSON.stringify(new URL("cloud-provider-worker.mjs", import.meta.url).href)};
    assert.equal(process.env.NODE_OPTIONS,${JSON.stringify(heapOptions)}); delete process.env.NODE_OPTIONS;
    const state={consumes:0,censuses:0,posts:0,deletes:0,heapLimit:getHeapStatistics().heap_size_limit};
    assert.ok(state.heapLimit<=80*1024*1024); const mode=${JSON.stringify(mode)},host=${JSON.stringify(host)};
    const save=()=>writeFileSync(${JSON.stringify(output)},JSON.stringify(state)); save();
    serveProviderWorker({now:()=>0,sleep:async()=>{},spawn(){state.consumes++;save();return{status:0,stdout:Buffer.from('SYNTHETIC_CENSUS_IPC_CREDENTIAL\\n')};},
      connect(){assert.fail('NO_NATIVE_HTTPS');},request({method,path}){
        if(path==='/v2/account')return{status:200,value:{account:{uuid:'synthetic-user-0001',droplet_limit:20}}};
        if(method==='GET'&&path==='/v2/droplets/123')return state.deletes?{status:503,value:null}:{status:200,value:{droplet:host}};
        if(method==='DELETE'){state.deletes++;save();return{status:204,value:null};}
        if(method==='POST'){state.posts++;save();throw new Error('NO_FAKE_CREATE_ALLOWED');}
        assert.ok(method==='GET'&&path==='/v2/droplets?page=1&per_page=200');state.censuses++;save();
        const mismatch=mode==='persistent'||mode==='transient'&&state.censuses===1||mode==='post-delete'&&state.deletes>0;
        const droplets=state.deletes?[]:host?[host]:[];
        return{status:200,value:{droplets,meta:{total:droplets.length+(mismatch?1:0)},links:{}}};
      }});`);
  let child;
  const run = workerTransport({ repo: realpathSync(resolve(".")), launch(binary, args, options) {
    assert.equal(binary, realpathSync(process.execPath)); assert.equal(args[0], "--input-type=module");
    assert.equal(args[1], "-"); assert.ok(args[2].endsWith("cloud-provider-worker.mjs"));
    child = fork(entry, [], { ...options, env: { ...options.env, NODE_OPTIONS: heapOptions } });
    return child;
  } });
  t.after(async () => {
    try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); }
    assert.ok(!child || child.exitCode !== null || child.signalCode !== null, "owned IPC child must settle");
    assert.equal(root.startsWith(join(tmpdir(), "census-worker-test-")), true); rmSync(root, { recursive: true, force: true });
  });
  return { run, counts: () => JSON.parse(readFileSync(output)), settled: () => child?.exitCode !== null || child?.signalCode !== null };
}

test("census transient mismatch stays inside the actual worker IPC and closes normally", { timeout: 15000 }, async (t) => {
  const h = censusWorker(t, "transient");
  assert.equal(JSON.parse((await h.run(list)).stdout).length, 0);
  assert.ok(JSON.parse((await h.run(account)).stdout).uuid === "synthetic-user-0001", "same worker remains usable");
  await h.run.close(); assert.equal(h.settled(), true);
  const state = h.counts(); assert.equal(state.censuses, 2); assert.equal(state.consumes, 1);
  assert.equal(state.posts, 0); assert.equal(state.deletes, 0); assert.ok(state.heapLimit <= 80 * 1024 * 1024);
});

test("census refused launch preserves caller locks and settlement with zero mutation", { timeout: 15000 }, async (t) => {
  const h = harness(t), worker = censusWorker(t, "persistent");
  const task = h.launch({ run: (binary, args, timeout, allowFail) => binary === "doctl"
    ? worker.run(args, timeout, allowFail) : h.run(binary, args, timeout, allowFail), settle: () => worker.run.close() });
  await assert.rejects(task.launch(), (error) => censusFailure(error) && error.controlTreeUncertain === true);
  assert.equal(h.saved().status, "reserved"); assert.equal(h.saved().createIntentAt, undefined);
  assert.ok(existsSync(join(h.local, "operation.lock")) && existsSync(join(h.base, ".groups-launch.lock")));
  const state = worker.counts(); assert.equal(state.censuses, 100); assert.equal(state.posts, 0); assert.equal(state.deletes, 0);
  assert.equal(worker.settled(), true);
  await assert.rejects(task.launch()); assert.equal(worker.counts().posts, 0);
});

test("exact-ID GET failure after acknowledged delete preserves intent and never replays the mutation", { timeout: 15000 }, async (t) => {
  const h = harness(t); h.seed(); const saved = h.saved();
  const host = { id: 123, name: saved.name, tags: [...tags, saved.tag], size_slug: saved.host.size,
    region: { slug: saved.host.region }, networks: { v4: [{ type: "public", ip_address: saved.ip }] } };
  const worker = censusWorker(t, "post-delete", host);
  const task = h.task({ run: (binary, args, timeout, allowFail) => binary === "doctl"
    ? worker.run(args, timeout, allowFail) : h.run(binary, args, timeout, allowFail), settle: () => worker.run.close() });
  await assert.rejects(task.collect(), (error) => error.providerDiagnostic?.code === "get-http"
    && error.providerDiagnostic.httpStatus === 503 && error.controlTreeUncertain === true);
  const state = h.saved(); assert.ok(state.archiveSha256 && state.evidenceSha256 && state.deletionIntentAt);
  assert.equal(state.destroyedAt, undefined); assert.equal(worker.counts().deletes, 1); assert.equal(worker.counts().posts, 0);
  assert.ok(existsSync(join(h.local, "operation.lock"))); assert.equal(worker.settled(), true);
  await assert.rejects(task.collect()); assert.equal(worker.counts().deletes, 1);
});

test("create failures retain only bounded phase codes and HTTP status, never raw evidence", async () => {
  for (const mode of ["response", "link", "action", "pending", "http", "transport"]) {
    let clock = 0, posts = 0, reads = 0;
    const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request({ method }) {
      if (method === "POST") {
        posts++;
        const response = publishedCreate();
        if (mode === "response") response.value.droplet.id = credential;
        if (mode === "link") response.value.links.actions[0].id = credential;
        return response;
      }
      reads++;
      if (mode === "http") return { status: 403, value: { raw: credential } };
      if (mode === "transport") throw new Error(`raw-native-${credential}`);
      return createAction(mode === "pending" ? "in-progress" : credential, mode === "pending" ? 0 : 3164444);
    } });
    const code = { response: "create-response", link: "create-link-id", action: "create-action-response", pending: "create-action-pending",
      http: "create-action-http", transport: "create-action-request" }[mode];
    await assert.rejects(run(create, 2500), (error) => {
      assert.deepEqual(error.providerDiagnostic, { code, ...(mode === "http" ? { httpStatus: 403 } : {}) });
      assert.equal(error.controlUncertain === true, ["pending", "transport"].includes(mode));
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(credential));
      return true;
    });
    assert.equal(posts, 1); assert.equal(reads, ["response", "link"].includes(mode) ? 0 : mode === "pending" ? 3 : 1);
  }
});

test("HTTP diagnostic status is optional and never reflects an unlisted number or native value", async () => {
  for (const status of [499, 999999, "SYNTHETIC_RAW_BODY", undefined]) {
    const run = providerTransport({ repo: resolve("."), spawn, request: () => ({ status, value: { raw: credential } }) });
    await assert.rejects(run(create, 1000), (error) => {
      assert.deepEqual(error.providerDiagnostic, { code: "create-http" });
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes("SYNTHETIC_RAW_BODY")); return true;
    });
  }
});

test("published create example and nullable in-progress action already satisfy the engine contract", async () => {
  for (const actionId of [7515, 3_000_000_001]) {
    const response = publishedCreate(), calls = []; let clock = 0;
    response.value.links.actions[0] = { id: actionId, rel: "create", href: `https://api.digitalocean.com/v2/actions/${actionId}` };
    const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request({ method, path, timeout }) {
      calls.push({ method, path, timeout });
      if (method === "POST") return response;
      const action = createAction(clock ? "completed" : "in-progress", clock ? 3164444 : null);
      action.value.action.id = actionId; return action;
    } });
    assert.deepEqual(JSON.parse((await run(create, 5000)).stdout), [{ id: response.value.droplet.id }]);
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets", timeout: 5000 },
      { method: "GET", path: `/v2/actions/${actionId}`, timeout: 5000 },
      { method: "GET", path: `/v2/actions/${actionId}`, timeout: 4000 }]);
  }
});

// The documented droplet-scoped endpoint reads the same action as the global
// endpoint. This is a synthetic contract case, not a retained r21 response:
// https://github.com/digitalocean/openapi/blob/998192821fe95ee79e41f577933601d009179dcf/specification/resources/droplets/dropletActions_get.yml
test("documented droplet-scoped create href still polls only the canonical exact action", async (t) => {
  for (const actionId of [7515, 3_000_000_001]) for (const pendingResource of [null, 0, 3164444]) {
    await t.test(`${actionId}/${pendingResource}`, async () => {
      const response = publishedCreate(), calls = []; let clock = 0;
      response.value.links.actions[0] = { id: actionId, rel: "create",
        href: `https://api.digitalocean.com/v2/droplets/${response.value.droplet.id}/actions/${actionId}` };
      const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; },
        request({ method, path, timeout }) {
          calls.push({ method, path, timeout });
          if (method === "POST") return response;
          const action = createAction(clock ? "completed" : "in-progress", clock ? response.value.droplet.id : pendingResource);
          action.value.action.id = actionId; return action;
        } });
      assert.deepEqual(JSON.parse((await run(create, 5000)).stdout), [{ id: response.value.droplet.id }]);
      assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets", timeout: 5000 },
        { method: "GET", path: `/v2/actions/${actionId}`, timeout: 5000 },
        { method: "GET", path: `/v2/actions/${actionId}`, timeout: 4000 }]);
    });
  }
});

// These omissions are permitted by shared/models/action_link.yml, not observed
// r21 responses. The example's rel/href values are not required schema fields:
// https://github.com/digitalocean/openapi/blob/998192821fe95ee79e41f577933601d009179dcf/specification/shared/models/action_link.yml
for (const omitted of [["rel"], ["href"], ["rel", "href"]]) {
  test(`schema-optional create-link ${omitted.join("+")} omissions still require exact completed action`, async () => {
    for (const actionId of [7515, 3_000_000_001]) {
      const response = publishedCreate(), calls = []; let clock = 0;
      response.value.links.actions[0] = { id: actionId, rel: "create", href: `https://api.digitalocean.com/v2/actions/${actionId}` };
      for (const key of omitted) delete response.value.links.actions[0][key];
      const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request({ method, path, timeout }) {
        calls.push({ method, path, timeout });
        if (method === "POST") { clock += 250; return response; }
        const action = createAction(clock < 1000 ? "in-progress" : "completed", clock < 1000 ? null : response.value.droplet.id);
        action.value.action.id = actionId; return action;
      } });
      assert.deepEqual(JSON.parse((await run(create, 5000)).stdout), [{ id: response.value.droplet.id }]);
      assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets", timeout: 5000 },
        { method: "GET", path: `/v2/actions/${actionId}`, timeout: 4750 },
        { method: "GET", path: `/v2/actions/${actionId}`, timeout: 3750 }]);
    }
  });
}

test("schema-conformant zero resource ID remains pending until the create action binds the exact droplet", async () => {
  // resource_id is integer + nullable, with no minimum in the published action
  // model. Zero is a synthetic schema instance, not a retained r21 response.
  // https://github.com/digitalocean/openapi/blob/998192821fe95ee79e41f577933601d009179dcf/specification/resources/actions/models/action.yml
  let clock = 0; const calls = [];
  const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request({ method, path }) {
    calls.push({ method, path });
    if (method === "POST") return publishedCreate();
    return createAction(clock ? "completed" : "in-progress", clock ? 3164444 : 0);
  } });
  assert.deepEqual(JSON.parse((await run(create, 5000)).stdout), [{ id: publishedCreate().value.droplet.id }]);
  assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" },
    { method: "GET", path: "/v2/actions/7515" }, { method: "GET", path: "/v2/actions/7515" }]);
});

test("unbound zero action cannot complete, poll past the deadline, or repeat POST", async () => {
  let clock = 0, posts = 0, reads = 0;
  const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request({ method }) {
    if (method === "POST") { posts++; return publishedCreate(); }
    reads++; return createAction("in-progress", 0);
  } });
  await assert.rejects(run(create, 2500, true), (error) => error.controlUncertain === true);
  assert.equal(clock, 2500); assert.equal(posts, 1); assert.equal(reads, 3);
  for (const resource_id of [0, null, -1, "0", undefined, 3164445]) {
    let requests = 0;
    const terminal = providerTransport({ repo: resolve("."), spawn, request({ method }) {
      requests++;
      if (method === "POST") return publishedCreate();
      const response = createAction(); response.value.action.resource_id = resource_id; return response;
    } });
    await assert.rejects(terminal(create, 1000)); assert.equal(requests, 2);
  }
});

test("create projection rejects invalid droplet IDs and ambiguous action IDs across advisory metadata", async () => {
  for (const hints of advisoryHints) {
    const link = { id: 7515, ...hints };
    const cases = [
      ...[undefined, null, "3164444", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((id) => ["create-response", (r) => { r.value.droplet.id = id; }]),
      ...[undefined, null, {}].map((actions) => ["create-link-shape", (r) => { r.value.links.actions = actions; }]),
      ...[[], [link, link]].map((actions) => ["create-link-count", (r) => { r.value.links.actions = actions; }]),
      ...[null, {}].map((entry) => ["create-link-id", (r) => { r.value.links.actions = [entry]; }]),
      ...[undefined, null, "7515", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((id) => ["create-link-id", (r) => { r.value.links.actions[0].id = id; }]),
    ];
    for (const [code, mutate] of cases) {
      const response = publishedCreate(), calls = []; response.value.links.actions = [link]; mutate(response);
      const run = providerTransport({ repo: resolve("."), spawn, request({ method, path }) { calls.push({ method, path }); return response; } });
      await assert.rejects(run(create, 1000), (error) => {
        assert.equal(error.providerDiagnostic?.code, code);
        assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(credential)); return true;
      });
      assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" }]);
    }
  }
});

test("ignored metadata cannot qualify a wrong, failed or unbound action", async () => {
  for (const hints of advisoryHints) for (const mutate of [
    (a) => { a.id = 7516; }, (a) => { a.id = "7515"; }, (a) => { delete a.id; },
    (a) => { a.type = "snapshot"; }, (a) => { a.resource_type = "image"; },
    ...[null, 0, 3164445, "3164444", undefined].map((id) => (a) => { a.resource_id = id; }),
    ...["errored", "unknown", undefined].map((status) => (a) => { a.status = status; }),
  ]) {
    const response = publishedCreate(), action = createAction(), calls = [];
    response.value.links.actions[0] = { id: 7515, ...hints };
    mutate(action.value.action);
    const run = providerTransport({ repo: resolve("."), spawn, request({ method, path }) {
      calls.push({ method, path }); return method === "POST" ? response : action;
    } });
    // Only the exact action bound to the POST droplet can report a provider-errored create.
    const code = isDeepStrictEqual(action.value.action, { ...createAction().value.action, status: "errored" }) ? "create-action-errored" : "create-action-response";
    await assert.rejects(run(create, 1000), (error) => error.providerDiagnostic?.code === code);
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" }, { method: "GET", path: "/v2/actions/7515" }]);
  }
});

test("first action failures after accepted POST stop without retry or leaking provider data", async () => {
  const action = createAction().value.action;
  const responses = [
    ...[301, 401, 403, 404, 429, 500].map((status) => ({ status, value: { raw: credential } })),
    ...[{ ...action, id: 7516 }, { ...action, type: "delete" }, { ...action, resource_type: "image" }, { ...action, resource_type: null },
      { ...action, resource_id: 3164445 }, { ...action, resource_id: null }, { ...action, resource_id: 0 },
      { ...action, status: "in-progress", resource_id: 3164445 }, { ...action, status: "in-progress", resource_id: -1 },
      { ...action, status: "in-progress", resource_id: "0" }, { ...action, status: "in-progress", resource_type: null, resource_id: 0 }, { ...action, status: "errored" },
      { ...action, status: "unknown" }].map((action) => ({ status: 200, value: { action } })),
    null,
  ];
  for (const link of [publishedCreate().value.links.actions[0], { id: action.id }]) {
    for (const response of responses) {
      const calls = [];
      const run = providerTransport({ repo: resolve("."), spawn, request({ method, path }) {
        calls.push({ method, path });
        if (method === "POST") { const created = publishedCreate(); created.value.links.actions = [link]; return created; }
        if (response === null) throw new Error(credential); return response;
      } });
      if (response !== null && response.status !== 200) {
        const result = await run(create, 1000, true);
        assert.equal(result.status, 1);
        assert.deepEqual(result.providerDiagnostic, { code: "create-action-http", httpStatus: response.status });
        assert.ok(!JSON.stringify(result).includes(credential));
      } else {
        await assert.rejects(run(create, 1000), (error) => {
          assert.equal(error.message, "provider control failed; preserve state/evidence/host");
          assert.equal(error.providerDiagnostic?.code, response === null ? "create-action-request"
            : isDeepStrictEqual(response.value.action, { ...action, status: "errored" }) ? "create-action-errored" : "create-action-response");
          assert.equal(error.controlUncertain === true, response === null);
          assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(credential)); return true;
        });
      }
      assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" }, { method: "GET", path: "/v2/actions/7515" }]);
    }
  }
});

test("completed create action must be observed before the original deadline", async () => {
  for (const hints of [advisoryHints[0], advisoryHints[2]]) for (const completedAt of [999, 1000, 1001]) for (const allowFail of [false, true]) {
    let clock = 0; const calls = [];
    const run = providerTransport({ repo: resolve("."), spawn, now: () => clock,
      request({ method, path, timeout }) {
        calls.push({ method, path, timeout });
        if (method === "POST") {
          clock = 100; const response = publishedCreate(); response.value.links.actions = [{ id: 7515, ...hints }]; return response;
        }
        clock = completedAt; return createAction("completed", 3164444);
      } });
    if (completedAt < 1000) assert.deepEqual(await run(create, 1000, allowFail), { status: 0, stdout: '[{"id":3164444}]', stderr: "" });
    else await assert.rejects(run(create, 1000, allowFail), (error) => {
      assert.equal(error.controlUncertain, true); assert.equal(error.providerDiagnostic?.code, "create-action-response"); return true;
    });
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets", timeout: 1000 }, { method: "GET", path: "/v2/actions/7515", timeout: 900 }]);
  }
});

test("ignored metadata never extends the original deadline or bypasses cancellation", async () => {
  for (const hints of advisoryHints) for (const mode of ["pending", "post-deadline", "cancelled", "transport"]) {
    let clock = 0, cancelled = false; const calls = [];
    const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, interrupted: () => cancelled,
      sleep: async (ms) => { clock += ms; if (mode === "cancelled") cancelled = true; }, request({ method, path, timeout }) {
        calls.push({ method, path, timeout });
        if (method === "POST") {
          const response = publishedCreate(); response.value.links.actions = [{ id: 7515,
            ...hints }];
          clock = mode === "post-deadline" ? 2500 : 500; return response;
        }
        if (mode === "transport") throw new Error(credential);
        return createAction("in-progress", 0);
      } });
    await assert.rejects(run(create, 2500, true), (error) => {
      assert.equal(error.providerDiagnostic?.code, { pending: "create-action-pending", "post-deadline": "create-link",
        cancelled: "create-action-pending", transport: "create-action-request" }[mode]);
      if (mode !== "cancelled") assert.equal(error.controlUncertain, true);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(credential)); return true;
    });
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets", timeout: 2500 },
      ...(mode === "post-deadline" ? [] : [{ method: "GET", path: "/v2/actions/7515", timeout: 2000 }]),
      ...(mode === "pending" ? [{ method: "GET", path: "/v2/actions/7515", timeout: 1000 }] : [])]);
  }
});

test("cancellation at the first action grant retains coarse create-link rather than a successful predicate code", async () => {
  let posts = 0, cancelled = false;
  const run = providerTransport({ repo: resolve("."), spawn, interrupted: () => cancelled,
    now: () => { if (posts) cancelled = true; return 0; }, request({ method }) {
      assert.equal(method, "POST"); posts++; return publishedCreate();
    } });
  await assert.rejects(run(create, 1000, true), (error) => {
    assert.equal(error.providerDiagnostic?.code, "create-link");
    assert.equal(error.controlUncertain, true); return true;
  });
  assert.equal(posts, 1);
});

test("provider consumes named stored credential once in private memory and never runs a provider CLI", async () => {
  const calls = [], values = [], buffers = []; let source = credential;
  const run = providerTransport({ repo: resolve("."), spawn(binary, argv, options) {
    const stdout = Buffer.from(`${source}\n`); buffers.push(stdout);
    calls.push({ binary, argv, options }); return { status: 0, stdout };
  }, request(options) { values.push(options.credential === credential); return { status: 200, value: { account: { uuid: "synthetic-user-0001" } } }; } });
  await run(account); source = "SYNTHETIC_ONLY_CREDENTIAL_B"; await run(account); source = credential; await run(account);
  assert.deepEqual(values, [true, true, true]); assert.equal(calls.length, 1);
  assert.ok(buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  assert.deepEqual(calls[0].argv.slice(0, 4), ["auth", "token", "--context", context]);
  assert.ok(!calls[0].argv.some((v) => v.includes("SYNTHETIC_ONLY_CREDENTIAL")));
  assert.equal(calls[0].options.env.DIGITALOCEAN_ACCESS_TOKEN, undefined);
  assert.equal(calls[0].options.stdio[0], "ignore"); assert.equal(calls[0].options.shell, false);
  await assert.rejects(run([...account.slice(0, -1), "synthetic-other-context"])); assert.equal(calls.length, 1);
});

test("failed/empty/multiline token consumption cannot issue a request or retry the store", async () => {
  for (const result of [{ status: 1, stdout: "synthetic-private-error" }, { status: null, error: {} }, { status: 0, stdout: "" }, { status: 0, stdout: `${credential}\n${credential}` }]) {
    let consumes = 0, requests = 0;
    const run = providerTransport({ repo: resolve("."), spawn() { consumes++; return result; }, request() { requests++; return empty; } });
    for (let i = 0; i < 2; i++) await assert.rejects(run(account), (error) => !error.message.includes("SYNTHETIC") && !error.message.includes("synthetic-private"));
    assert.equal(consumes, 1); assert.equal(requests, 0);
  }
});

test("complete bounded pagination retains hosts beyond page one and rejects incomplete/foreign censuses", async () => {
  let requests = 0;
  const run = providerTransport({ repo: resolve("."), spawn, request({ path }) {
    requests++; const first = path.includes("page=1&");
    return { status: 200, value: { droplets: [{ id: first ? 1 : 2 }], meta: { total: 2 },
      links: first ? { pages: { next: "https://api.digitalocean.com/v2/droplets?per_page=200&page=2" } } : {} } };
  } });
  assert.deepEqual(JSON.parse((await run(list)).stdout), [{ id: 1 }, { id: 2 }]); assert.equal(requests, 2);
  for (const value of [
    { droplets: [], meta: { total: 1 }, links: {} },
    { droplets: [{ id: 1 }, { id: 1 }], meta: { total: 2 }, links: {} },
    { droplets: [{ id: 1 }], meta: { total: 2 }, links: { pages: { next: "https://synthetic.invalid/v2/droplets?page=2&per_page=200" } } },
    { droplets: [{ id: 1 }], meta: { total: 2 }, links: { pages: { next: "https://api.digitalocean.com/v2/droplets?page=1&per_page=200" } } },
  ]) {
    let calls = 0;
    const bad = providerTransport({ repo: resolve("."), spawn, sleep: async () => {}, request() { calls++; return { status: 200, value }; } });
    await assert.rejects(bad(list)); assert.equal(calls, value.droplets.length === 0 ? 100 : 1);
  }
});

test("create is one POST followed only by bounded matching action reads; delete is one DELETE", async () => {
  const calls = []; let clock = 0;
  const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request({ method, path, body }) {
    calls.push({ method, path, body });
    if (method === "POST") return { status: 202, value: { droplet: { id: 123 }, links: { actions: [{ id: 456, rel: "create", href: "https://api.digitalocean.com/v2/actions/456" }] } } };
    if (method === "DELETE") return { status: 204, value: null };
    return { status: 200, value: { action: { id: 456, type: "create", resource_id: clock ? 123 : null, resource_type: "droplet", status: clock ? "completed" : "in-progress" } } };
  } });
  await run(create, 5000); await run(["compute", "droplet", "delete", "123", "--force", "--context", context]);
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "GET", "DELETE"]);
  assert.deepEqual(calls[0].body.ssh_keys, [42]); assert.equal(calls[0].body.name, create[3]);
  const timed = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request: async (options) => {
    if (options.method === "POST") return { status: 202, value: { droplet: { id: 123 }, links: { actions: [{ id: 456, rel: "create", href: "https://api.digitalocean.com/v2/actions/456" }] } } };
    return { status: 200, value: { action: { id: 456, type: "create", resource_id: 123, resource_type: "droplet", status: "in-progress" } } };
  } });
  await assert.rejects(timed(create, 10, true), (error) => error.controlUncertain === true);
});

test("HTTP failures, redirects and ambiguous requests are never retried or exposed", async () => {
  for (const status of [301, 401, 429, 500]) {
    let count = 0;
    const run = providerTransport({ repo: resolve("."), spawn, request() { count++; return { status, value: { raw: credential } }; } });
    const result = await run(create, 1000, true); assert.equal(result.status, 1); assert.ok(!JSON.stringify(result).includes(credential)); assert.equal(count, 1);
  }
  let count = 0;
  const uncertain = providerTransport({ repo: resolve("."), spawn, request() { count++; throw new Error(credential); } });
  await assert.rejects(uncertain(create, 1000, true), (error) => error.controlUncertain === true && !error.message.includes(credential)); assert.equal(count, 1);
});

test("native catalog distinguishes complete invalid JSON, closed truncation and timeout", { timeout: 10000 }, async (t) => {
  let mode = "malformed";
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/v2/sizes?page=1&per_page=200");
    if (mode === "malformed") res.end("{");
    else if (mode === "truncated") { res.writeHead(200, { "content-length": 10 }); res.end("{"); }
    else { res.writeHead(200); res.flushHeaders(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const connect = (url, options, callback) =>
    httpRequest({ ...options, hostname: "127.0.0.1", port: server.address().port, path: url.pathname + url.search }, callback);
  const run = providerTransport({ repo: resolve("."), spawn, connect });
  const command = [...fleetCatalogCommand, "--context", context];
  const refused = await run(command, 1000, true);
  assert.deepEqual({ status: refused.status, stdout: refused.stdout, stderr: refused.stderr, diagnostic: refused.providerDiagnostic },
    { status: 1, stdout: "", stderr: "", diagnostic: { code: "catalog-response" } });
  mode = "truncated";
  await assert.rejects(run(command, 1000, true), (error) => {
    assert.ok(isSettledCatalogFailure(error)); assert.equal(error.controlUncertain, undefined);
    assert.deepEqual(error.providerDiagnostic, { code: "catalog-request", detail: "response-aborted" }); return true;
  });
  mode = "slow";
  await assert.rejects(run(command, 100, true), (error) => {
    assert.equal(isSettledCatalogFailure(error), false); assert.equal(error.controlUncertain, true);
    assert.deepEqual(error.providerDiagnostic, { code: "catalog-request", detail: "deadline" }); return true;
  });
});

test("native create reports a fixed transport reason without resolving or retrying its POST", { timeout: 10000 }, async (t) => {
  let mode, requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v2/droplets");
    req.resume();
    if (mode === "request-error") req.socket.destroy();
    else if (mode === "response-aborted") {
      res.writeHead(202, { "content-length": 100 });
      res.end("{");
    } else if (mode === "invalid-json") res.writeHead(202).end(credential + " is not JSON");
    else { res.writeHead(202); res.flushHeaders(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  for (const detail of ["request-error", "response-aborted", "invalid-json", "deadline"]) {
    mode = detail;
    const prior = requests;
    const run = providerTransport({ repo: resolve("."), spawn, connect(url, options, callback) {
      assert.equal(url.origin, "https://api.digitalocean.com");
      return httpRequest({ ...options, hostname: "127.0.0.1", port: server.address().port, path: url.pathname }, callback);
    } });
    await assert.rejects(run(create, detail === "deadline" ? 500 : 2000, true), (error) => {
      assert.equal(error.controlUncertain, true);
      assert.ok(!error.pendingCreate);
      assert.ok(!JSON.stringify(error).includes(credential));
      assert.deepEqual(error.providerDiagnostic, { code: "create-request", detail });
      return true;
    });
    assert.equal(requests, prior + 1);
  }
});

test("native HTTP boundary pins origin, sends only memory credential and bounds redirects/body/deadline/cancellation", { timeout: 10000 }, async (t) => {
  let requests = 0, route = "account";
  const server = createServer((req, res) => {
    requests++; assert.ok(req.headers.authorization === `Bearer ${credential}`);
    if (route === "redirect") { res.writeHead(302, { location: "http://synthetic.invalid" }); res.end(credential); }
    else if (route === "slow") res.writeHead(200);
    else if (route === "malformed") { res.writeHead(200); res.end("not JSON"); }
    else if (route === "oversized") { res.writeHead(200); res.end(Buffer.alloc(16 * 1024 ** 2 + 1, 120)); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ account: { uuid: "synthetic-user-0001" } })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const connect = (url, options, callback) => {
    assert.equal(url.origin, "https://api.digitalocean.com");
    return httpRequest({ ...options, hostname: "127.0.0.1", port: server.address().port, path: url.pathname + url.search }, callback);
  };
  let cancelled = false;
  const run = providerTransport({ repo: resolve("."), spawn, connect, interrupted: () => cancelled });
  assert.equal(JSON.parse((await run(account, 1000)).stdout).uuid, "synthetic-user-0001");
  const settledRead = (error) => isSettledAccountFailure(error) && error.controlUncertain === undefined;
  route = "redirect"; await assert.rejects(run(account, 1000, true), settledRead);
  assert.equal(requests, 2);
  route = "malformed"; await assert.rejects(run(account, 1000), settledRead);
  route = "oversized"; await assert.rejects(run(account, 1000), settledRead);
  route = "slow"; await assert.rejects(run(account, 50), (error) => error.controlUncertain === true);
  const timer = setTimeout(() => { cancelled = true; }, 50);
  try { await assert.rejects(run(account, 1000), (error) => error.controlUncertain === true); }
  finally { clearTimeout(timer); }
});
