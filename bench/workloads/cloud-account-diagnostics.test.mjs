// In-memory provider events and synthetic credential consumption only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createProviderEngine } from "./cloud-engine-test-fixture.mjs";
import { providerDiagnostic, providerFailure, controllerFailure } from "./cloud-options.mjs";
import { providerTransport } from "./cloud-provider.mjs";
import { productionMain } from "./cloud-production.mjs";
import { publicError } from "./droplet.mjs";
import { accountId, commit, context, harness as controllerHarness } from "./cloud-fixtures.mjs";
import { beforeProvisioning, settlementControl } from "./test-fixtures/provider-settlement-control.mjs";

const credential = "SYNTHETIC_ACCOUNT_DIAGNOSTICS_CREDENTIAL";
const account = ["account", "get", "--output", "json", "--context", context];
const create = ["compute", "droplet", "create", "corten-bench-groups-r83-0123456789abcdef", "--size", "c-8", "--region", "sfo3",
  "--image", "ubuntu-24-04-x64", "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef",
  "--wait", "--output", "json", "--context", context];
const details = ["internal-refusal", "connect", "send", "request-error", "response-error", "response-aborted",
  "response-status", "body-limit", "invalid-json", "deadline", "cancelled"];
const state = () => ({ consumes: 0, calls: [], getters: 0, destroyed: 0 });
const workerActionTimeout = 2000;

// Freeze the request budget across the pre-request checkpoint, then advance it
// only after the unanswered request has been sent and its timer is armed.
function expireOnSend(timers, timeout, observed) {
  timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  return () => {
    timers.tick(timeout - 1);
    assert.equal(observed.destroyed, 0);
    timers.tick(1);
    assert.equal(observed.destroyed, 1);
  };
}

// Also evaluated in a test-only worker entry, before its verified-import hook.
// No Node error property, endpoint override or native network call is consulted.
function fakeConnect(mode, observed, save = () => {}, stop = () => {}, local, beforeProvisioning) {
  let created;
  const raw = "SYNTHETIC_ACCOUNT_DIAGNOSTICS_CREDENTIAL";
  const hostile = () => Object.defineProperties({}, Object.fromEntries(["message", "code", "stack", "body", "endpoint", "providerDiagnostic", "controlUncertain"].map((key) =>
    [key, { get() { observed.getters++; save(); throw new Error(raw); } }])));
  return (url, options, callback) => {
    assert.equal(url.origin, "https://api.digitalocean.com");
    assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.headers.authorization, `Bearer ${raw}`);
    const path = url.pathname + url.search;
    observed.calls.push({ method: options.method, path }); save();
    const fail = !local || path === "/v2/account" && beforeProvisioning(local);
    if (fail && mode === "connect") throw hostile();
    const req = new EventEmitter();
    req.destroy = () => { observed.destroyed++; save(); };
    req.end = () => {
      if (fail && mode === "send") throw hostile();
      queueMicrotask(() => {
        if (fail && mode === "request-error") { req.emit("error", hostile()); return; }
        if (fail && (mode === "deadline" || mode === "cancelled")) { stop(); return; }
        const res = new EventEmitter();
        res.statusCode = fail && mode === "http503" ? 503 : fail && mode === "response-status" ? "not-an-integer" : options.method === "POST" ? 202 : 200;
        res.destroy = () => { observed.destroyed++; save(); };
        callback(res);
        if (fail && mode === "response-error") { res.emit("error", hostile()); return; }
        if (fail && mode === "response-aborted") { res.emit("aborted"); return; }
        if (fail && mode === "body-limit") { res.emit("data", Buffer.alloc(16 * 1024 ** 2 + 1)); return; }
        if (fail && mode === "invalid-json") { res.emit("data", Buffer.from(raw)); res.emit("end"); return; }
        let value;
        if (path === "/v2/account") value = mode === "missing-account" ? {} : { account: { uuid: fail && mode === "reflect" ? raw : "synthetic-user-0001", droplet_limit: 20 } };
        else if (path.startsWith("/v2/droplets?")) value = { droplets: created ? [created] : [], meta: { total: created ? 1 : 0 }, links: {} };
        else if (options.method === "POST") {
          const saved = JSON.parse(readFileSync(join(local, "state.json")));
          created = { id: 123, name: saved.name, tags: ["corten-bench", "corten-bench-groups", saved.tag], size_slug: "c-8",
            region: { slug: "sfo2" }, networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } };
          value = { droplet: created, links: { actions: [{ id: 456 }] } };
        } else if (path === "/v2/actions/456") value = { action: { id: 456, resource_id: 123, resource_type: "droplet", type: "create", status: "completed" } };
        else if (path === "/v2/droplets/123") value = { droplet: created };
        else assert.fail("unexpected synthetic request");
        res.emit("data", Buffer.from(fail && mode === "http503" ? raw : JSON.stringify(value)));
        res.emit("end");
        if (mode === "post-response-cancel") stop();
      });
    };
    return req;
  };
}

function checkFailure(error, diagnostic, uncertain = true) {
  assert.deepEqual(providerFailure(error), diagnostic);
  assert.equal(error.controlUncertain === true, uncertain);
  assert.ok(!`${publicError(error)}${error.stack}${JSON.stringify(error)}`.includes(credential));
  return true;
}

test("account request native rejection sites have closed details without reading errors or retrying", async (t) => {
  for (const detail of details) await t.test(detail, async (t) => {
    const observed = state(); let cancelled = false;
    const timeout = detail === "internal-refusal" ? 1000000 : detail === "deadline" ? 30 : 1000;
    const stop = detail === "deadline" ? expireOnSend(t.mock.timers, timeout, observed) : () => { cancelled = true; };
    const run = createProviderEngine({ repo: resolve("."), interrupted: () => cancelled,
      spawn() { observed.consumes++; return { status: 0, stdout: Buffer.from(credential) }; },
      connect: fakeConnect(detail, observed, undefined, stop) });
    await assert.rejects(run(account, timeout),
      (error) => checkFailure(error, { code: "account-request", detail }));
    assert.equal(observed.calls.length, detail === "internal-refusal" ? 0 : 1);
    assert.equal(observed.consumes, 1); assert.equal(observed.getters, 0);
  });
});

test("account details do not change HTTP, successful-shape, output or checkpoint acceptance", async () => {
  for (const [mode, expected, uncertain] of [["http503", { code: "account-http", httpStatus: 503 }, false],
    ["reflect", { code: "provider-output" }, false], ["post-response-cancel", { code: "account-request" }, false]]) {
    const observed = state(); let cancelled = false;
    const run = createProviderEngine({ repo: resolve("."), interrupted: () => cancelled,
      spawn: () => ({ status: 0, stdout: Buffer.from(credential) }), connect: fakeConnect(mode, observed, undefined, () => { cancelled = true; }) });
    await assert.rejects(run(account), (error) => checkFailure(error, expected, uncertain));
    assert.equal(observed.calls.length, 1);
  }
  const observed = state(), run = createProviderEngine({ repo: resolve("."), spawn: () => ({ status: 0, stdout: Buffer.from(credential) }),
    connect: fakeConnect("missing-account", observed) });
  assert.deepEqual(await run(account), { status: 0, stdout: "", stderr: "" });
  // Other request phases must not inherit account-specific details.
  const other = createProviderEngine({ repo: resolve("."), spawn: () => ({ status: 0, stdout: Buffer.from(credential) }), connect: fakeConnect("request-error", state()) });
  await assert.rejects(other(["compute", "droplet", "list", "--output", "json", "--context", context]),
    (error) => checkFailure(error, { code: "list-request" }));
  const unknown = createProviderEngine({ repo: resolve("."), spawn: () => ({ status: 0, stdout: Buffer.from(credential) }),
    request() { throw { get providerDiagnostic() { assert.fail("request error getter evaluated"); } }; } });
  await assert.rejects(unknown(account), (error) => checkFailure(error, { code: "account-request" }));
});

test("account request details never turn a native failure into an allowed HTTP result", async () => {
  const observed = state(), run = createProviderEngine({ repo: resolve("."),
    spawn() { observed.consumes++; return { status: 0, stdout: Buffer.from(credential) }; }, connect: fakeConnect("request-error", observed) });
  await assert.rejects(run(account, 1000, true), (error) => checkFailure(error, { code: "account-request", detail: "request-error" }));
  assert.equal(observed.calls.length, 1); assert.equal(observed.consumes, 1); assert.equal(observed.getters, 0);
});

test("diagnostic table rejects unknown, extra, conflicting and accessor fields without reflection", () => {
  for (const detail of details) assert.deepEqual(providerDiagnostic({ code: "account-request", detail }), { code: "account-request", detail });
  for (const value of [{ code: "account-request", detail: credential }, { code: "account-request", detail: {} },
    { code: "account-request", detail: "connect", body: credential }, { code: "account-request", detail: "connect", httpStatus: 503 },
    { code: "account-request", detail: "connect", get raw() { assert.fail("extra getter evaluated"); } },
    { code: "list-request", detail: "connect" }, { code: "account-http", detail: "connect" },
    { code: "account-request", get detail() { assert.fail("detail getter evaluated"); } },
    { get code() { assert.fail("code getter evaluated"); }, detail: "connect" }]) {
    assert.equal(providerDiagnostic(value), undefined);
    assert.equal(publicError({ providerDiagnostic: value }), publicError());
  }
  assert.equal(providerFailure({ get providerDiagnostic() { assert.fail("error getter evaluated"); } }), undefined);
});

function worker(t, mode, local, receive = (value) => value, createMode = null) {
  const root = mkdtempSync(join(tmpdir(), "account-diagnostic-test-")), entry = join(root, "entry.mjs"), output = join(root, "observed.json");
  const serve = new URL("cloud-provider-worker.mjs", import.meta.url).href;
  writeFileSync(entry, `import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { serveProviderWorker } from ${JSON.stringify(serve)};
assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=256'); delete process.env.NODE_OPTIONS;
assert.deepEqual(process.execArgv, []); process.stdin.resume();
const observed = ${JSON.stringify(state())}, save = () => writeFileSync(${JSON.stringify(output)}, JSON.stringify(observed)); save();
const fakeConnect = ${fakeConnect.toString()};
const beforeProvisioning = ${beforeProvisioning.toString()};
const stop = ${mode === "deadline" ? `(${expireOnSend.toString()})(mock.timers, ${workerActionTimeout}, observed)` : "undefined"};
serveProviderWorker({ spawn() { observed.consumes++; save(); return {status:0, stdout:Buffer.from(${JSON.stringify(credential)})}; },
connect: fakeConnect(${JSON.stringify(mode)}, observed, save, stop, ${JSON.stringify(local)}, beforeProvisioning) });
`);
  let child, launches = 0; const messages = [];
  const run = providerTransport({ repo: resolve("."), createMode, launch(path, args, options) {
    launches++; assert.equal(path, realpathSync(process.execPath));
    assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-"]);
    assert.deepEqual(options.execArgv, []);
    assert.ok(!Object.keys(options.env).some((name) => /^(?:NODE_|SSL|OPENSSL|LD_|DYLD_)/i.test(name)));
    child = spawn(path, [entry], { ...options, env: { ...options.env, NODE_OPTIONS: "--max-old-space-size=256" } });
    const emit = child.emit.bind(child);
    child.emit = (name, ...values) => {
      if (name === "message") messages.push(values[0]);
      return emit(name, ...(name === "message" ? [receive(values[0]), ...values.slice(1)] : values));
    };
    return child;
  } });
  t.after(async () => {
    try {
      try { await run.close(); } catch (error) { assert.equal(error.controlUncertain, true); }
      assert.ok(child === undefined || child.exitCode !== null || child.signalCode !== null);
      assert.ok(!JSON.stringify(messages).includes(credential));
    } finally {
      assert.ok(root.startsWith(join(tmpdir(), "account-diagnostic-test-"))); rmSync(root, { recursive: true, force: true });
    }
  });
  return { run, observed: () => JSON.parse(readFileSync(output)), get child() { return child; }, get launches() { return launches; } };
}

test("private worker IPC and repeated cached settlement preserve account details without policy changes", async (t) => {
  for (const detail of ["connect", "send", "request-error", "response-error", "response-aborted", "response-status", "body-limit", "invalid-json", "deadline"]) await t.test(detail, async (t) => {
    const h = worker(t, detail);
    const check = (error) => { assert.equal(error.controlTreeUncertain, true); return checkFailure(error, { code: "account-request", detail }); };
    await assert.rejects(h.run(account, workerActionTimeout), check);
    await assert.rejects(h.run.close(), check); await assert.rejects(h.run.close(), check);
    // close() may win the unchanged worker's failed-send callback race and
    // exit 0; neither orderly exit clears the parent's sticky uncertainty.
    assert.ok([0, 2].includes(h.child.exitCode)); assert.equal(h.child.signalCode, null); assert.equal(h.launches, 1);
    t.diagnostic(`observed worker exit ${h.child.exitCode}; cached settlement remains uncertain`);
    assert.equal(h.observed().consumes, 1); assert.equal(h.observed().calls.length, 1); assert.equal(h.observed().getters, 0);
  });
});

test("invalid account details in actual worker replies fail closed and never become public data", async (t) => {
  for (const result of [{ code: "account-request", detail: credential }, { code: "account-request", detail: "connect", raw: credential },
    { code: "account-request", detail: "connect", httpStatus: 503 }, { code: "list-request", detail: "connect" }]) {
    const h = worker(t, "request-error", undefined, (message) => message.ok === false ? { ...message, result } : message);
    await assert.rejects(h.run(account), (error) => checkFailure(error, undefined));
    await assert.rejects(h.run.close(), (error) => checkFailure(error, undefined));
    assert.equal(h.observed().calls.length, 1); assert.equal(h.observed().consumes, 1);
  }
});

test("private worker keeps ambiguous create details through teardown and refuses another POST", async (t) => {
  for (const detail of ["request-error", "invalid-json"]) await t.test(detail, async (t) => {
    const h = worker(t, detail, undefined, undefined, "dedicated");
    const check = (error) => {
      assert.equal(error.controlTreeUncertain, true);
      assert.equal(error.pendingCreate, undefined);
      return checkFailure(error, { code: "create-request", detail });
    };
    await assert.rejects(h.run(create, workerActionTimeout, true), check);
    await assert.rejects(h.run.close(), check);
    await assert.rejects(h.run(create, workerActionTimeout, true), check);
    assert.equal(h.launches, 1);
    assert.deepEqual(h.observed().calls, [{ method: "POST", path: "/v2/droplets" }]);
    assert.equal(h.observed().consumes, 1);
    assert.equal(h.observed().getters, 0);
  });
});

test("production finalizer preserves detail after allocation while retaining locks and refusing replay", async (t) => {
  for (const mode of ["request-error", "invalid-json", "http503"]) await t.test(mode, async (t) => {
    const h = controllerHarness(t), workers = []; let approval;
    const deps = { ...settlementControl(t, h), repo: h.repo, write(value) { approval = JSON.parse(value).approvalSha256; },
      providerFactory({ createMode }) { const w = worker(t, mode, h.local, undefined, createMode); workers.push(w); return w.run; } };
    const args = ["r21", "--state-dir", h.base, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
    assert.equal(await productionMain([...args, "--print-approval"], deps), 3); assert.equal(workers[0].launches, 0);
    const diagnostic = mode === "http503" ? { code: "account-http", httpStatus: 503 } : { code: "account-request", detail: mode };
    await assert.rejects(productionMain([...args, "--approve-reviewed-merged-ready", approval], deps), (error) => {
      assert.equal(controllerFailure(error), "provider-settlement"); assert.equal(error.controlTreeUncertain, true);
      return checkFailure(error, diagnostic);
    });
    const w = workers[1], observed = w.observed();
    assert.ok([0, 2].includes(w.child.exitCode)); assert.equal(w.child.signalCode, null);
    assert.equal(observed.consumes, 1); assert.equal(observed.getters, 0);
    assert.equal(observed.calls.filter((value) => value.method === "POST").length, 1);
    assert.equal(observed.calls.filter((value) => value.method === "DELETE").length, 0);
    assert.deepEqual(observed.calls.at(-1), { method: "GET", path: "/v2/account" });
    assert.equal(h.saved().status, "preparing"); assert.equal(h.saved().id, "123");
    assert.equal(h.saved().deletionIntentAt, undefined); assert.equal(h.saved().fullGroupQualified, false);
    assert.deepEqual(h.saved().control.ledger, []); assert.equal(existsSync(join(h.local, "job.sh")), false);
    assert.ok(existsSync(join(h.local, "operation.lock")));
    assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
    const before = h.calls.length;
    await assert.rejects(h.task().collect(), { code: "EEXIST" }); assert.equal(h.calls.length, before);
  });
});
