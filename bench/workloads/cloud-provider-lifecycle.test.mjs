import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createProviderEngine } from "./cloud-engine-test-fixture.mjs";
import { providerDiagnostic } from "./cloud-options.mjs";

const credential = "SYNTHETIC_LIFECYCLE_CREDENTIAL";
const context = ["--context", "synthetic-lifecycle"];
const list = ["compute", "droplet", "list", "--output", "json", ...context];
const get = (id = "123") => ["compute", "droplet", "get", id, "--output", "json", ...context];
const account = ["account", "get", "--output", "json", ...context];
const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3",
  "--image", "ubuntu-24-04-x64", "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef",
  "--wait", "--output", "json", ...context];
const page = (rows, total) => ({ status: 200, value: { droplets: rows, meta: { total }, links: {} } });
function fixture(request, sleep) {
  const state = { time: 0, cancelled: false, consumes: 0, calls: [], sleeps: [] };
  const run = createProviderEngine({ repo: resolve("."), now: () => state.time, interrupted: () => state.cancelled,
    spawn() { state.consumes++; return { status: 0, stdout: Buffer.from(`${credential}\n`) }; },
    async sleep(ms) { state.sleeps.push(ms); state.time += ms; await sleep?.(state); },
    request(options) { state.calls.push({ method: options.method, path: options.path, timeout: options.timeout });
      assert.equal(options.credential === credential, true); return request(options, state); } });
  return { run, state };
}

test("supported lifecycle census converges on a third count observation without retaining old rows", async () => {
  const responses = [page([{ id: 1 }], 2), page([{ id: 2 }], 3), page([{ id: 3 }], 1)];
  const { run, state } = fixture(() => responses.shift());
  assert.equal(JSON.parse((await run(list, 5000)).stdout)[0].id, 3);
  assert.deepEqual(state.calls.map(({ path }) => path), Array(3).fill("/v2/droplets?page=1&per_page=200"));
  assert.deepEqual(state.calls.map(({ timeout }) => timeout), [5000, 4000, 3000]);
  assert.deepEqual(state.sleeps, [1000, 1000]);
});

test("supported lifecycle exact-ID GET returns one ID-bound droplet array", async () => {
  for (const id of ["123", "3000000001", String(Number.MAX_SAFE_INTEGER)]) {
    const { run, state } = fixture(() => ({ status: 200, value: { droplet: { id: Number(id), name: "synthetic-owned" } } }));
    const result = await run(get(id), 1000);
    assert.equal(result.status, 0); assert.equal(result.stderr, "");
    const rows = JSON.parse(result.stdout); assert.equal(rows.length, 1); assert.equal(rows[0].id, Number(id));
    assert.deepEqual(state.calls, [{ method: "GET", path: `/v2/droplets/${id}`, timeout: 1000 }]);
  }
});

test("supported lifecycle only explicit allowFail GET404 is absence, never another error", async () => {
  for (const status of [404, 301, 401, 403, 429, 500]) for (const allowFail of [false, true]) {
    const { run, state } = fixture(() => ({ status, value: { raw: credential } }));
    if (status === 404 && allowFail) {
      const result = await run(get(), 1000, true);
      assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
      assert.deepEqual(result.providerDiagnostic, { code: "get-http", httpStatus: 404 });
      assert.ok(!JSON.stringify(result).includes(credential));
    } else await assert.rejects(run(get(), 1000, allowFail), (error) => error.providerDiagnostic?.code === "get-http"
      && error.providerDiagnostic.httpStatus === status && !JSON.stringify(error).includes(credential));
    assert.equal(state.calls.length, 1);
  }
});

test("supported lifecycle exact-ID GET refuses malformed commands and mismatched successful responses", async () => {
  for (const id of ["0", "-1", "01", "1.5", "9007199254740992", "123/other", "https://foreign.invalid", "123?x=1"]) {
    const { run, state } = fixture(() => assert.fail("invalid ID must not make a request"));
    await assert.rejects(run(get(id))); assert.equal(state.calls.length, 0);
  }
  for (const value of [null, {}, { droplet: null }, { droplet: [] }, { droplet: { id: 124 } }, { droplet: { id: "123" } }]) {
    const { run, state } = fixture(() => ({ status: 200, value }));
    await assert.rejects(run(get(), 1000, true), (error) => error.providerDiagnostic?.code === "get-response");
    assert.equal(state.calls.length, 1);
  }
});

test("supported lifecycle known create refusal permits same-credential recovery without success or another POST", async () => {
  const { run, state } = fixture(({ method, path }) => {
    if (method === "POST") return { status: 202, value: { droplet: { id: 123 },
      links: { actions: [{ id: credential, rel: "create", href: `https://foreign.invalid/${credential}` }] } } };
    if (path === "/v2/account") return { status: 200, value: { account: { uuid: "synthetic-account" } } };
    if (path === "/v2/droplets/123") return { status: 200, value: { droplet: { id: 123 } } };
    return page([{ id: 123 }], 1);
  });
  const failed = await run(create, 1000, true);
  assert.equal(failed.status, 1); assert.equal(failed.stdout, ""); assert.equal(failed.stderr, "");
  assert.deepEqual(failed.providerDiagnostic, { code: "create-link-id" });
  assert.ok(!JSON.stringify(failed).includes(credential));
  for (const command of [account, list, get()]) assert.equal((await run(command)).status, 0);
  assert.equal(state.consumes, 1); assert.equal(state.calls.filter(({ method }) => method === "POST").length, 1);
  assert.equal(state.calls.some(({ method }) => method === "DELETE"), false);
});

test("supported lifecycle count convergence stops at its global100GET bound, not an unbounded retry", async () => {
  const { run, state } = fixture(() => page([], 1));
  await assert.rejects(run(list, 200000), (error) => {
    assert.deepEqual(error.providerDiagnostic, { code: "list-response-count", detail: "terminal-count-mismatch" }); return true;
  });
  assert.equal(state.calls.length, 100); assert.equal(state.sleeps.length, 99);
  assert.equal(state.time, 99000);
});

test("supported lifecycle count pacing honors original deadline and cancellation before another GET", async () => {
  for (const mode of ["deadline", "cancel", "reverse"]) {
    const { run, state } = fixture(() => page([], 1), (s) => { if (mode === "cancel") s.cancelled = true; if (mode === "reverse") s.time = -1; });
    await assert.rejects(run(list, mode === "deadline" ? 1000 : 5000), (error) => error.controlUncertain === true
      && error.providerDiagnostic?.code === "list-response");
    assert.equal(state.calls.length, 1); assert.deepEqual(state.sleeps, [1000]);
  }
});

test("supported lifecycle get transport, deadline and cancellation never report absence", async () => {
  for (const mode of ["request", "deadline", "cancel", "reflection"]) {
    const { run, state } = fixture((_, s) => {
      if (mode === "request") throw new Error(credential);
      if (mode === "deadline") s.time = 1000;
      if (mode === "cancel") s.cancelled = true;
      return { status: 200, value: { droplet: { id: 123, ...(mode === "reflection" ? { name: credential } : {}) } } };
    });
    await assert.rejects(run(get(), 1000, true), (error) => !JSON.stringify(error).includes(credential));
    assert.equal(state.calls.length, 1);
  }
});

test("supported lifecycle expired or cancelled create refusal is uncertainty, never a recoverable semantic result", async () => {
  for (const mode of ["deadline", "cancel", "reverse", "invalid-clock"]) {
    const { run, state } = fixture((_, s) => {
      if (mode === "deadline") s.time = 1000;
      if (mode === "cancel") s.cancelled = true;
      if (mode === "reverse") s.time = -1;
      if (mode === "invalid-clock") s.time = NaN;
      return { status: 202, value: { droplet: { id: 123 }, links: { actions: [] } } };
    });
    await assert.rejects(run(create, 1000, true), (error) => error.providerDiagnostic?.code === (mode === "cancel" ? "create-request" : "create-link")
      && (mode === "cancel" || error.controlUncertain === true));
    assert.equal(state.calls.length, 1);
  }
});

test("supported lifecycle arbitrary hints cannot affect the ID-only projection or canonical proof", async () => {
  // Deliberate projection boundary cases, not claims that malformed hints are URIs.
  for (const hints of [{}, { href: null, rel: false }, { href: { private: credential }, rel: [credential] },
    { href: `https://${credential}@foreign.invalid/private#fragment`, rel: "delete" }, { href: "not a URI", rel: 1 }]) {
    const { run, state } = fixture(({ method }) => method === "POST"
      ? { status: 202, value: { droplet: { id: 123, unused: credential }, links: { actions: [{ id: 456, ...hints }] } } }
      : { status: 200, value: { action: { id: 456, type: "create", resource_type: "droplet", resource_id: 123, status: "completed" } } });
    const result = await run(create, 1000, true);
    assert.deepEqual(result, { status: 0, stdout: '[{"id":123}]', stderr: "" });
    assert.ok(!JSON.stringify(result).includes(credential));
    assert.deepEqual(state.calls, [{ method: "POST", path: "/v2/droplets", timeout: 1000 },
      { method: "GET", path: "/v2/actions/456", timeout: 1000 }]);
  }
});

test("historical diagnostic parser remains code-specific finite data, not current hint emission", () => {
  assert.deepEqual(providerDiagnostic({ code: "create-link-href" }), { code: "create-link-href" });
  assert.deepEqual(providerDiagnostic({ code: "list-response-count", detail: "total-changed" }), { code: "list-response-count", detail: "total-changed" });
  for (const value of [{ code: "create-link-href", detail: credential }, { code: "get-http", httpStatus: 404, detail: "foreign-origin" },
    { code: "create-link-rel", detail: "foreign-origin" }, { code: "list-response-count", detail: "foreign-origin" },
    { code: "create-link-href", detail: "foreign-origin", raw: credential }, { code: "create-link-href", detail: { raw: credential } },
    { code: "create-link-href", get detail() { throw new Error(credential); } }]) assert.equal(providerDiagnostic(value), undefined);
});

test("supported lifecycle total-changed detail requires exhausting the same global GET bound", async () => {
  const { run, state } = fixture((_, s) => s.calls.length % 2 ? {
    status: 200, value: { droplets: [{ id: 1 }], meta: { total: 2 }, links: { pages: { next: "https://api.digitalocean.com/v2/droplets?page=2&per_page=200" } } },
  } : page([{ id: 2 }], 3));
  await assert.rejects(run(list, 200000), (error) => {
    assert.deepEqual(error.providerDiagnostic, { code: "list-response-count", detail: "total-changed" }); return true;
  });
  assert.equal(state.calls.length, 100); assert.equal(state.sleeps.length, 49);
});
