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
