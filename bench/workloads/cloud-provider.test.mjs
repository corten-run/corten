import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import { createProviderEngine as providerTransport } from "./cloud-engine-test-fixture.mjs";
import { context } from "./cloud-fixtures.mjs";

const credential = "SYNTHETIC_ONLY_CREDENTIAL_A";
const account = ["account", "get", "--output", "json", "--context", context];
const list = ["compute", "droplet", "list", "--output", "json", "--context", context];
const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo2", "--image", "ubuntu-24-04-x64",
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

test("create failures retain only bounded phase codes and HTTP status, never raw evidence", async () => {
  for (const mode of ["response", "link", "action", "pending", "http", "transport"]) {
    let clock = 0, posts = 0, reads = 0;
    const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request({ method }) {
      if (method === "POST") {
        posts++;
        const response = publishedCreate();
        if (mode === "response") response.value.droplet.id = credential;
        if (mode === "link") response.value.links.actions[0].href = `https://synthetic.invalid/${credential}`;
        return response;
      }
      reads++;
      if (mode === "http") return { status: 403, value: { raw: credential } };
      if (mode === "transport") throw new Error(`raw-native-${credential}`);
      return createAction(mode === "pending" ? "in-progress" : credential, mode === "pending" ? 0 : 3164444);
    } });
    const code = { response: "create-response", link: "create-link", action: "create-action-response", pending: "create-action-pending",
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
    assert.deepEqual(JSON.parse((await run(create, 5000)).stdout), [response.value.droplet]);
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets", timeout: 5000 },
      { method: "GET", path: `/v2/actions/${actionId}`, timeout: 5000 },
      { method: "GET", path: `/v2/actions/${actionId}`, timeout: 4000 }]);
  }
});

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
  assert.deepEqual(JSON.parse((await run(create, 5000)).stdout), [publishedCreate().value.droplet]);
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
    await assert.rejects(terminal(create, 1000, true)); assert.equal(requests, 2);
  }
});

test("accepted create rejects ambiguous links before any action read and never repeats POST", async () => {
  const link = publishedCreate().value.links.actions[0];
  for (const actions of [undefined, [], [link, link], [{ ...link, rel: "delete" }], [{ ...link, id: "7515" }],
    ...["http://api.digitalocean.com/v2/actions/7515", "https://synthetic.invalid/v2/actions/7515",
      "https://api.digitalocean.com/v2/actions/7516", "https://api.digitalocean.com/v2/actions/7515?next=1",
      "https://api.digitalocean.com/v2/actions/7515#fragment"].map((href) => [{ ...link, href }])]) {
    const calls = [], response = publishedCreate(); response.value.links.actions = actions;
    const run = providerTransport({ repo: resolve("."), spawn, request({ method, path }) { calls.push({ method, path }); return response; } });
    await assert.rejects(run(create, 1000, true));
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" }]);
  }
});

test("first action failures after accepted POST stop without retry or leaking provider data", async () => {
  const action = createAction().value.action;
  for (const response of [
    ...[301, 401, 403, 404, 429, 500].map((status) => ({ status, value: { raw: credential } })),
    ...[{ ...action, id: 7516 }, { ...action, type: "delete" }, { ...action, resource_type: "image" }, { ...action, resource_type: null },
      { ...action, resource_id: 3164445 }, { ...action, resource_id: null }, { ...action, resource_id: 0 },
      { ...action, status: "in-progress", resource_id: 3164445 }, { ...action, status: "in-progress", resource_id: -1 },
      { ...action, status: "in-progress", resource_id: "0" }, { ...action, status: "in-progress", resource_type: null, resource_id: 0 }, { ...action, status: "errored" },
      { ...action, status: "unknown" }].map((action) => ({ status: 200, value: { action } })),
    null,
  ]) {
    const calls = [];
    const run = providerTransport({ repo: resolve("."), spawn, request({ method, path }) {
      calls.push({ method, path }); if (method === "POST") return publishedCreate();
      if (response === null) throw new Error(credential); return response;
    } });
    try {
      const result = await run(create, 1000, true);
      assert.equal(result.status, 1); assert.ok(!JSON.stringify(result).includes(credential));
    } catch (error) { assert.equal(error.message, "provider control failed; preserve state/evidence/host"); }
    assert.deepEqual(calls, [{ method: "POST", path: "/v2/droplets" }, { method: "GET", path: "/v2/actions/7515" }]);
  }
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
    const bad = providerTransport({ repo: resolve("."), spawn, request() { calls++; return { status: 200, value }; } });
    await assert.rejects(bad(list)); assert.equal(calls, 1);
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
  route = "redirect"; const redirected = await run(account, 1000, true);
  assert.equal(redirected.status, 1); assert.equal(redirected.stdout, ""); assert.equal(requests, 2);
  route = "malformed"; await assert.rejects(run(account, 1000), (error) => error.controlUncertain === true);
  route = "oversized"; await assert.rejects(run(account, 1000), (error) => error.controlUncertain === true);
  route = "slow"; await assert.rejects(run(account, 50), (error) => error.controlUncertain === true);
  const timer = setTimeout(() => { cancelled = true; }, 50);
  try { await assert.rejects(run(account, 1000), (error) => error.controlUncertain === true); }
  finally { clearTimeout(timer); }
});
