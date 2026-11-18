import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { providerTransport } from "./cloud-provider.mjs";
import { productionMain } from "./cloud-production.mjs";
import { providerFailure, controllerFailure } from "./cloud-options.mjs";
import { accountId, commit, context, harness, syntheticProviderRequest } from "./cloud-fixtures.mjs";
import { beforeProvisioning, settlementControl } from "./test-fixtures/provider-settlement-control.mjs";

const account = ["account", "get", "--output", "json", "--context", context];
const raw = "SYNTHETIC_ONLY_CREDENTIAL_A";
async function api(t, mode, h) {
  const calls = [], responses = [], sockets = new Set(); let injected = false, armed = true;
  const translate = h && syntheticProviderRequest(h);
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${raw}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const path = req.url, method = req.method; calls.push({ method, path });
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, ...rest) => { responses.push({ method, path, status }); return writeHead(status, ...rest); };
    if (mode === "refused-create" && method === "POST") { res.writeHead(503); res.end(raw); return; }
    const mutation = mode === "action" && path === "/v2/actions/456" || mode === "post" && method === "POST" || mode === "delete" && method === "DELETE";
    const fail = armed && !injected && (mutation || path === "/v2/account" && (!h || beforeProvisioning(h.local)));
    if (fail && mode !== "success") {
      injected = true;
      if (["action", "post", "delete"].includes(mode)) { req.socket.destroy(); return; }
      if (mode === "reset") { req.socket.destroy(); return; }
      if (["hang", "cancel"].includes(mode)) return;
      if (mode === "aborted") { res.writeHead(200); res.flushHeaders(); res.write('{"account":'); setImmediate(() => res.destroy()); return; }
      res.writeHead(mode === "invalid-json" ? 200 : 503); res.end(raw); return;
    }
    const result = translate ? await translate({ method, path, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined,
      timeout: 60000, credential: raw }) : { status: 200, value: { account: { uuid: "synthetic-user-0001" } } };
    res.writeHead(result.status); res.end(result.value === null ? "" : JSON.stringify(result.value));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); assert.equal(sockets.size, 0); });
  return { port: server.address().port, calls, responses, arm(value) { armed = value; }, get injected() { return injected; } };
}
function worker(t, api, { mode = "ordinary", receive = (value) => value, interrupted = () => false, onExit } = {}) {
  const root = mkdtempSync(join(tmpdir(), "account-settlement-test-")), output = join(root, "observed.json");
  let child; const messages = [];
  const run = providerTransport({ repo: resolve("."), interrupted, launch(path, args, options) {
    assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-"]);
    child = spawn(path, [fileURLToPath(new URL("cloud-account-settlement-fixture.mjs", import.meta.url)), String(api.port), output, mode],
      { ...options, env: { ...options.env, NODE_OPTIONS: "--max-old-space-size=256" } });
    if (onExit) child.once("exit", onExit);
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
      assert.ok(!child || child.exitCode !== null || child.signalCode !== null);
      assert.ok(!JSON.stringify(messages).includes(raw));
    } finally { assert.ok(root.startsWith(join(tmpdir(), "account-settlement-test-"))); rmSync(root, { recursive: true, force: true }); }
  });
  return { run, messages, state: () => JSON.parse(readFileSync(output)), get child() { return child; } };
}
function failed(error, code, detail) {
  assert.equal(error.controlUncertain, undefined); assert.equal(error.controlTreeUncertain, undefined);
  assert.deepEqual(providerFailure(error), { code, ...(detail ? { detail } : { httpStatus: 503 }) });
  assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(raw)); return true;
}

test("native account rejection requires request/response/socket close and typed terminal reply plus exit0", { timeout: 20000 }, async (t) => {
  for (const [mode, code, detail] of [["http503", "account-http"], ["invalid-json", "account-request", "invalid-json"],
    ["reset", "account-request", "request-error"], ["aborted", "account-request", "response-aborted"]]) await t.test(mode, async (t) => {
    const a = await api(t, mode), w = worker(t, a);
    await assert.rejects(w.run(account, 5000), (error) => failed(error, code, detail));
    await w.run.close(); await w.run.close();
    assert.equal(w.child.exitCode, 0); assert.equal(w.child.signalCode, null);
    assert.equal(w.state().consumes, 1); assert.equal(w.state().requests, 1); assert.equal(w.state().credentialExited, true);
    assert.equal(w.state().requestClose, 1); assert.equal(w.state().socketClose, 1);
    assert.equal(w.state().responseClose, mode === "reset" ? 0 : 1);
    const terminal = w.messages.find((value) => value.schema === "cloud-provider-account-failed/v2");
    assert.ok(terminal); assert.equal(terminal.disposition, "resources-closed");
    assert.equal(a.calls.length, 1);
    await assert.rejects(w.run(account)); assert.equal(w.state().requests, 1);
    t.diagnostic(`native ${mode}: reqClose=${w.state().requestClose} resClose=${w.state().responseClose} socketClose=${w.state().socketClose}, exit0, one request, failed not accepted`);
  });
});

const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo2", "--image", "ubuntu-24-04-x64",
  "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", "--context", context];
test("native account settlement cannot erase preceding create ambiguity or authorize other command replies", { timeout: 15000 }, async (t) => {
  const a = await api(t, "refused-create"), w = worker(t, a);
  assert.equal((await w.run(create, 2000, true)).status, 1);
  await assert.rejects(w.run(account, 2000), (error) => error.controlUncertain === true);
  await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
  assert.equal(w.messages.some((value) => value.schema === "cloud-provider-account-failed/v2"), false);
  assert.equal(a.calls.filter((v) => v.method === "POST").length, 1); assert.equal(w.state().consumes, 1);
  for (const [mode, args] of [["post", create], ["delete", ["compute", "droplet", "delete", "123", "--force", "--context", context]]]) await t.test(mode, async (t) => {
    const a = await api(t, mode); let forged = false;
    const w = worker(t, a, { receive(message) {
      if (message.schema !== "cloud-provider-result/v1" || message.ok !== false) return message;
      forged = true;
      return { schema: "cloud-provider-account-failed/v2", nonce: message.nonce, sequence: message.sequence,
        disposition: "resources-closed", diagnostic: { code: "account-http", httpStatus: 503 } };
    } });
    await assert.rejects(w.run(args, 2000, true), (error) => error.controlUncertain === true);
    await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
    assert.ok(forged); assert.equal(a.calls.length, 1);
  });
});

test("terminal reply ordering before disconnect and cancellation before exit are distinct", { timeout: 10000 }, async (t) => {
  for (const cancelAfterProof of [false, true]) await t.test(String(cancelAfterProof), async (t) => {
    const a = await api(t, "http503"); let cancelled = false;
    const w = worker(t, a, { interrupted: () => cancelled, receive(message) {
      if (message.schema === "cloud-provider-account-failed/v2") queueMicrotask(() => {
        if (cancelAfterProof) cancelled = true;
        else w.child.emit("disconnect");
      });
      return message;
    } });
    if (cancelAfterProof) {
      await assert.rejects(w.run(account, 2000), (error) => error.controlUncertain === true);
      await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
    } else {
      await assert.rejects(w.run(account, 2000, true), (error) => failed(error, "account-http"));
      await w.run.close(); assert.equal(w.child.exitCode, 0);
    }
  });
});

test("native deadline, cancellation and unobserved resource close stay uncertain with no terminal proof", { timeout: 60000 }, async (t) => {
  for (const mode of ["hang", "cancel", "unobserved-close", "engine-clock", "credential-hang"]) await t.test(mode, async (t) => {
    const a = await api(t, mode); let cancel = false;
    const w = worker(t, a, { mode, interrupted: () => cancel });
    if (mode !== "credential-hang") {
      a.arm(false); assert.equal((await w.run(account, 15000)).status, 0); a.arm(true);
    }
    let timer;
    if (mode === "cancel") timer = setInterval(() => { if (a.injected) cancel = true; }, 10);
    try { await assert.rejects(w.run(account, 500, true), (error) => error.controlUncertain === true); }
    finally { clearInterval(timer); }
    await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
    assert.equal(w.messages.some((value) => value.schema === "cloud-provider-account-failed/v2"), false);
    assert.equal(w.state().requests, mode === "credential-hang" ? 0 : 2); assert.equal(w.state().consumes, 1);
    if (mode === "credential-hang") assert.equal(w.state().credentialTimedOut, true);
  });
});

test("typed proof rejects wrong nonce/sequence/grammar/version and unexpected exit", { timeout: 60000 }, async (t) => {
  for (const mode of ["nonce", "sequence", "extra", "diagnostic", "disposition", "version", "duplicate", "exit", "disconnect", "exit2", "withhold-exit", "deadline-exit", "parent-clock", "parent-clock-exit"]) await t.test(mode, async (t) => {
    const a = await api(t, "http503"); let altered = false; const clock = Date.now;
    const w = worker(t, a, { mode, receive(message) {
      if (message.schema !== "cloud-provider-account-failed/v2") return message;
      if (altered) return message;
      altered = true;
      if (mode === "nonce") return { ...message, nonce: "0".repeat(32) };
      if (mode === "sequence") return { ...message, sequence: message.sequence + 1 };
      if (mode === "extra") return { ...message, raw };
      if (mode === "diagnostic") return { ...message, diagnostic: { code: "account-http", httpStatus: 503, body: raw } };
      if (mode === "disposition") return { ...message, disposition: "trusted" };
      if (mode === "version") return { ...message, schema: "cloud-provider-account-failed/v3" };
      if (mode === "duplicate") queueMicrotask(() => w.child.emit("message", message));
      if (mode === "exit") w.child.kill("SIGKILL");
      if (mode === "disconnect") w.child.emit("disconnect");
      if (mode === "parent-clock") Date.now = () => clock() - 50000;
      if (mode === "parent-clock-exit") queueMicrotask(() => { Date.now = () => clock() - 50000; });
      return message;
    } });
    a.arm(false); assert.equal((await w.run(account, 15000)).status, 0); a.arm(true);
    try {
      await assert.rejects(w.run(account, mode === "deadline-exit" ? 250 : 2000), (error) => error.controlUncertain === true);
      await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
    } finally { Date.now = clock; }
    assert.ok(altered); assert.equal(w.state().requests, 2);
  });
});

test("allocated failed account read settles before unlock, fresh ordinary collect retires once with exact404", { timeout: 15000 }, async (t) => {
  const h = harness(t), a = await api(t, "invalid-json", h), workers = []; let approval;
  let locksAtWorkerExit;
  const deps = { ...settlementControl(t, h), repo: h.repo, write(value) { approval = JSON.parse(value).approvalSha256; },
    providerFactory() {
      const w = worker(t, a, { onExit() {
        if (workers[1] === w) locksAtWorkerExit = [join(h.local, "operation.lock"), join(h.base, ".groups-launch.lock")].map(existsSync);
      } });
      workers.push(w); return w.run;
    } };
  const args = ["r21", "--state-dir", h.base, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  await productionMain([...args, "--print-approval"], deps);
  await assert.rejects(productionMain([...args, "--approve-reviewed-merged-ready", approval], deps), (error) => {
    assert.equal(controllerFailure(error), "controller-launch"); return failed(error, "account-request", "invalid-json");
  });
  const launched = workers[1]; assert.equal(launched.child.exitCode, 0);
  assert.equal(launched.state().consumes, 1);
  assert.equal(h.saved().status, "preparing"); assert.equal(h.saved().fullGroupQualified, false);
  assert.equal(h.saved().id, "123"); assert.deepEqual(h.saved().control.ledger, []);
  assert.equal(a.injected, true); assert.deepEqual(a.calls.at(-1), { method: "GET", path: "/v2/account" });
  assert.deepEqual(locksAtWorkerExit, [true, true]);
  assert.equal(existsSync(join(h.local, "operation.lock")), false); assert.equal(existsSync(join(h.base, ".groups-launch.lock")), false);
  assert.equal(a.calls.filter((v) => v.method === "POST").length, 1); assert.equal(a.calls.filter((v) => v.method === "DELETE").length, 0);
  assert.equal(h.calls.some((row) => row[0] === "scp" || row[0] === "ssh" && row.at(-1).startsWith("systemctl start")), false);
  const collect = ["r21", "--state-dir", h.base, "--collect"];
  await productionMain([...collect, "--print-approval"], deps);
  assert.equal(await productionMain([...collect, "--approve-reviewed-merged-ready", approval], deps), 1);
  assert.equal(h.saved().status, "retired"); assert.equal(h.saved().retirement.kind, "unused"); assert.ok(h.saved().destroyedAt);
  assert.equal(h.saved().fullGroupQualified, false); assert.equal(h.saved().validation, undefined);
  assert.equal(workers[3].state().consumes, 1); assert.equal(workers[3].child.exitCode, 0);
  const deletedAt = a.responses.findIndex((row) => row.method === "DELETE" && row.path === "/v2/droplets/123" && row.status === 204);
  assert.ok(deletedAt >= 0);
  assert.ok(a.responses.slice(deletedAt + 1).some((row) => row.method === "GET" && row.path === "/v2/droplets/123" && row.status === 404));
  assert.ok(h.calls.some((row) => row[0] === "ssh" && row.at(-1).includes("benchmark-unused-host/v1")));
  assert.ok(existsSync(join(h.local, "unused-host.json"))); assert.ok(h.saved().deletionIntentAt);
  assert.equal(a.calls.filter((v) => v.method === "DELETE").length, 1);
  assert.equal(a.calls.filter((v) => v.method === "POST").length, 1);
  await productionMain([...collect, "--print-approval"], deps);
  assert.equal(await productionMain([...collect, "--approve-reviewed-merged-ready", approval], deps), 1);
  assert.equal(a.calls.filter((v) => v.method === "DELETE").length, 1);
  t.diagnostic("failed allocation: no lifetime flags; fresh collect: unused receipt + durable intent + one DELETE + exact404; repeat collect: zero DELETE");
});

test("composed unknown/unclosed/cancel/deadline/mutation failures retain exclusive locks without replay", { timeout: 45000 }, async (t) => {
  for (const mode of ["unknown", "unobserved-close", "cancel", "hang", "action", "post", "delete"]) await t.test(mode, async (t) => {
    const h = harness(t);
    if (mode === "delete") { h.seed(); h.change((s) => { s.status = "preparing"; }); }
    const a = await api(t, mode, h), workers = []; let approval;
    const deps = { ...settlementControl(t, h), repo: h.repo, write(value) { approval = JSON.parse(value).approvalSha256; },
      providerFactory() {
        const w = worker(t, a, { mode, interrupted: () => mode === "cancel" && a.injected,
          receive: (message) => mode === "unknown" && message.schema === "cloud-provider-account-failed/v2" ? { ...message, disposition: "unknown" } : message });
        workers.push(w);
        const run = (args, timeout, ...rest) => w.run(args, Math.min(timeout, 2000), ...rest);
        run.close = w.run.close; return run;
      } };
    const args = mode === "delete" ? ["r21", "--state-dir", h.base, "--collect"]
      : ["r21", "--state-dir", h.base, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
    await productionMain([...args, "--print-approval"], deps);
    await assert.rejects(productionMain([...args, "--approve-reviewed-merged-ready", approval], deps), (error) => {
      assert.equal(error.controlUncertain, true); assert.equal(error.controlTreeUncertain, true); return true;
    });
    assert.ok(existsSync(join(h.local, "operation.lock")));
    if (mode !== "delete") assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
    else assert.ok(h.saved().deletionIntentAt);
    assert.equal(h.saved().fullGroupQualified, false); assert.equal(h.saved().destroyedAt, undefined);
    assert.equal(a.injected, true);
    assert.equal(a.calls.filter((v) => v.method === "POST").length, mode === "delete" ? 0 : 1);
    assert.equal(a.calls.filter((v) => v.method === "DELETE").length, mode === "delete" ? 1 : 0);
    assert.deepEqual(a.calls.at(-1), mode === "action" ? { method: "GET", path: "/v2/actions/456" }
      : mode === "post" ? { method: "POST", path: "/v2/droplets" }
      : mode === "delete" ? { method: "DELETE", path: "/v2/droplets/123" } : { method: "GET", path: "/v2/account" });
    const before = h.calls.length, providerBefore = a.calls.length;
    if (["action", "post"].includes(mode)) {
      // The unbound create is refused before collect can try the operation lock.
      await assert.rejects(h.task().collect(), /monitor not registered; preserve pending reservation/);
      await assert.rejects(h.launch().launch(), { code: "EEXIST" });
    } else await assert.rejects(h.task().collect(), { code: "EEXIST" });
    assert.equal(h.calls.length, before); assert.equal(a.calls.length, providerBefore);
    await assert.rejects(workers[1].run.close(), (error) => error.controlUncertain === true);
    t.diagnostic(`${mode}: sticky uncertainty + retained operation lock; no repeated mutation`);
  });
});
