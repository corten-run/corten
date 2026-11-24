import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import { providerTransport } from "./cloud-provider.mjs";
import { fleetCatalogCommand, fleetCreateMode, fleetPlan } from "./cloud-contract.mjs";
import { productionMain } from "./cloud-production.mjs";
import { providerFailure, controllerFailure } from "./cloud-options.mjs";
import { accountId, commit, context, harness, syntheticProviderRequest } from "./cloud-fixtures.mjs";
import { beforeProvisioning, settlementControl } from "./test-fixtures/provider-settlement-control.mjs";

const account = ["account", "get", "--output", "json", "--context", context];
const raw = "SYNTHETIC_ONLY_CREDENTIAL_A";
async function api(t, mode, h, failureReady = () => !h || beforeProvisioning(h.local)) {
  const calls = [], responses = [], sockets = new Set(); let firstFailure = -1, armed = true;
  const translate = h && syntheticProviderRequest(h);
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${raw}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const path = req.url, method = req.method; calls.push({ method, path });
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, ...rest) => { responses.push({ method, path, status }); return writeHead(status, ...rest); };
    if (mode.startsWith("catalog-") && method !== "GET") { res.writeHead(405); res.end(); return; }
    if (mode === "refused-create" && method === "POST") { res.writeHead(503); res.end(raw); return; }
    const mutation = mode === "action" && path === "/v2/actions/456" || mode === "post" && method === "POST" || mode === "delete" && method === "DELETE";
    const failingRead = mode.startsWith("catalog-") ? path === "/v2/regions?page=1&per_page=200" : path === "/v2/account";
    const fail = armed && (firstFailure === -1 || mode === "reset-repeat") && (mutation || failingRead && failureReady());
    if (fail && mode !== "success") {
      if (firstFailure === -1) firstFailure = calls.length - 1;
      if (["action", "post", "delete", "reset", "reset-repeat", "refused-create", "catalog-reset"].includes(mode)) { req.socket.destroy(); return; }
      if (["hang", "cancel", "catalog-hang"].includes(mode)) return;
      if (["aborted", "catalog-aborted"].includes(mode)) {
        res.writeHead(200); res.flushHeaders(); res.write('{"partial":'); setImmediate(() => res.destroy()); return;
      }
      res.writeHead(mode === "invalid-json" ? 200 : 503); res.end(raw); return;
    }
    const result = translate ? await translate({ method, path, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined,
      timeout: 60000, credential: raw }) : { status: 200, value: { account: { uuid: "synthetic-user-0001" } } };
    res.writeHead(result.status); res.end(result.value === null ? "" : JSON.stringify(result.value));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); assert.equal(sockets.size, 0); });
  return { port: server.address().port, calls, responses, arm(value) { armed = value; },
    get injected() { return firstFailure !== -1; }, get firstFailure() { return firstFailure; } };
}
function worker(t, api, { mode = "ordinary", receive = (value) => value, interrupted = () => false, onExit, createMode = "legacy" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "account-settlement-test-")), output = join(root, "observed.json");
  let child; const messages = [];
  const run = providerTransport({ repo: resolve("."), interrupted, createMode, launch(path, args, options) {
    assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-"]);
    child = spawn(path, [fileURLToPath(new URL("cloud-account-settlement-fixture.mjs", import.meta.url)), String(api.port), output, mode],
      { ...options, env: { ...options.env, NODE_OPTIONS: "--max-old-space-size=256" } });
    if (onExit) child.once("exit", onExit);
    const emit = child.emit.bind(child);
    child.emit = (name, ...values) => {
      if (name !== "message") return emit(name, ...values);
      messages.push(values[0]);
      const delivered = receive(values[0]);
      return delivered === undefined ? true : emit(name, delivered, ...values.slice(1));
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

test("terminal catalog proof waits for the owned worker's IPC drain and clean exit", async (t) => {
  for (const mode of ["duplicate-after-exit", "malformed-after-exit", "internal-after-exit", "exit-first", "drain-first",
    "foreign-drain", "no-drain", "no-exit", "no-proof", "signaled", "connected-disconnect"]) await t.test(mode, async () => {
    const child = new EventEmitter(), action = Promise.withResolvers();
    child.connected = true; child.channel = {};
    let kills = 0;
    child.kill = (signal) => {
      assert.equal(mode, "no-exit", "must not signal an exited worker");
      assert.equal(signal, "SIGKILL"); kills++;
      child.emit("exit", null, signal);
    };
    const drain = (target = child) => {
      target.connected = false; target.channel = null; target.emit("disconnect");
    };
    child.stdin = Object.assign(new EventEmitter(), { end() { queueMicrotask(() => child.emit("message", { schema: "cloud-provider-boot/v1" })); } });
    let nonce;
    child.send = (message) => {
      if (message.schema === "cloud-provider-init/v2") {
        nonce = message.nonce;
        queueMicrotask(() => child.emit("message", { schema: "cloud-provider-result/v1", nonce, sequence: 0, ok: true, result: "ready" }));
      }
      if (message.schema === "cloud-provider-action/v1") action.resolve(message.sequence);
    };
    const run = providerTransport({ repo: resolve("."), createMode: "dedicated", launch: () => child });
    let runFinished = false, closeFinished = false;
    const outcome = run([...fleetCatalogCommand, "--context", context], 2000, true).catch((error) => error)
      .then((value) => { runFinished = true; return value; });
    const sequence = await action.promise;
    const proof = { schema: "cloud-provider-catalog-failed/v1", nonce, sequence,
      disposition: "resources-closed", diagnostic: { code: "catalog-request", detail: "request-error" } };
    if (mode !== "no-proof") child.emit("message", proof);
    await turn(); // Both callers can now be waiting on the same cached teardown.
    const closure = run.close().then(() => undefined, (error) => error).then((value) => { closeFinished = true; return value; });
    if (mode === "drain-first" || mode === "no-exit") drain();
    else if (mode === "foreign-drain") {
      drain(new EventEmitter());
      child.emit("exit", 0, null);
    } else if (mode === "connected-disconnect") child.emit("disconnect");
    else if (mode !== "no-proof") child.emit("exit", mode === "signaled" ? null : 0, mode === "signaled" ? "SIGTERM" : null);
    await turn(); // The deliberately delayed frames below arrive after exit's promise callbacks.
    const beforeBoth = [runFinished, closeFinished];
    if (mode === "duplicate-after-exit") child.emit("message", proof);
    if (mode === "malformed-after-exit") child.emit("message", { schema: "broken" });
    if (mode === "internal-after-exit") child.emit("internalMessage", { cmd: "NODE_UNEXPECTED" });
    if (!["drain-first", "no-drain", "no-exit"].includes(mode)) drain();
    if (["drain-first", "no-proof", "connected-disconnect"].includes(mode)) child.emit("exit", 0, null);
    const [error, closeError] = await Promise.all([outcome, closure]);
    assert.equal(kills, mode === "no-exit" ? 1 : 0);
    if (!["exit-first", "drain-first", "foreign-drain"].includes(mode)) {
      assert.equal(error?.controlTreeUncertain, true);
      assert.equal(closeError?.controlTreeUncertain, true);
    } else {
      failed(error, "catalog-request", "request-error");
      assert.equal(closeError, undefined);
    }
    assert.deepEqual(beforeBoth, [false, false]);
  });
});

test("locked marketplace catalog request releases custody only after proved native closure and clean exit", { timeout: 25000 }, async (t) => {
  for (const [mode, failure, detail, uncertain] of [
    ["reset", "catalog-reset", "request-error", false],
    ["aborted", "catalog-aborted", "response-aborted", false],
    ["unobserved-close", "catalog-reset", "request-error", true],
    ["hang", "catalog-hang", "deadline", true],
    ["exit2", "catalog-reset", "request-error", true],
    ["cancel-at-exit", "catalog-reset", "request-error", true],
    ["missing-proof", "catalog-reset", undefined, true],
    ["bad-diagnostic", "catalog-reset", undefined, true],
    ["ordinary-failure-result", "catalog-reset", undefined, true],
    ["prior-delete-attempt", "catalog-reset", "request-error", true],
    ["read-only-worker", "catalog-reset", "request-error", true],
  ]) await t.test(mode, async (t) => {
    const group = "localized-marketplace", round = "r63", h = harness(t, { round, fleetGroup: group });
    const locks = [join(h.base, ".groups-launch.lock"), join(h.local, "operation.lock")];
    const savedFleet = fleetPlan({ round, commit, token: "f".repeat(16), tokens: { [group]: "1".repeat(16) }, provider: { accountId, context }, sshKey: "42" },
      undefined, "sfo3", { stagedPlacement: true, single: { group, indexSha256: "a".repeat(64), checkout: h.repo } });
    const fleet = join(h.temp, "fleet.json"); writeFileSync(fleet, JSON.stringify(savedFleet));
    let locksAtExit, cancelled = false;
    const a = await api(t, failure, h, () => {
      assert.deepEqual(locks.map(existsSync), [true, true]);
      assert.equal(h.saved().status, "reserved"); assert.equal(h.saved().createIntentAt, undefined);
      return true;
    });
    const w = worker(t, a, { createMode: mode === "read-only-worker" ? null : fleetCreateMode(group, savedFleet),
      mode: mode === "unobserved-close" ? "catalog-unobserved-close" : mode,
      interrupted: () => cancelled,
      onExit() { locksAtExit = locks.map(existsSync); cancelled = mode === "cancel-at-exit"; },
      receive(message) {
        if (message.schema === "cloud-provider-catalog-failed/v1") {
          if (mode === "missing-proof") return undefined;
          if (mode === "bad-diagnostic") return { ...message, diagnostic: { code: "catalog-request", detail: "send" } };
          if (mode === "ordinary-failure-result") return { schema: "cloud-provider-result/v1", nonce: message.nonce, sequence: message.sequence,
            ok: true, result: { status: 1, stdout: "", stderr: "", providerDiagnostic: message.diagnostic } };
        }
        return message;
      } });
    if (mode === "prior-delete-attempt") {
      const deleted = await w.run(["compute", "droplet", "delete", "123", "--force", "--context", context], 2200, true, Date.now() - 1);
      assert.equal(deleted.deleteNotDispatched, true);
      assert.deepEqual(a.calls, []);
    }
    const task = h.task({
      run(binary, args, timeout, allowFail) {
        if (binary === "doctl") return w.run(args, args[1] === "placement" ? 2200 : timeout, allowFail);
        assert.equal(binary, "git");
        return h.run(binary, args, timeout, allowFail);
      },
      settle: () => w.run.close(),
      interrupted: () => cancelled,
      checkFleetAdmission: () => [],
    }, { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group, fleet });
    let rejected;
    await assert.rejects(task.launch(), (error) => { rejected = error; return true; });
    assert.equal(a.injected, true);
    assert.deepEqual(a.calls.map(({ method, path }) => [method, path]), [
      "/v2/account", "/v2/droplets?page=1&per_page=200", ...Array(5).fill("/v2/account"),
      "/v2/sizes?page=1&per_page=200", "/v2/regions?page=1&per_page=200",
    ].map((path) => ["GET", path]));
    assert.deepEqual(locksAtExit, [true, true]);
    assert.equal(h.saved().status, "reserved"); assert.equal(h.saved().createIntentAt, undefined);
    assert.equal(h.saved().id, undefined);
    t.diagnostic(`worker exit=${w.child.exitCode}, ${a.calls.length} GET, zero POST/DELETE, reservation still reserved, locks retained=${locks.map(existsSync)}`);
    assert.deepEqual(locks.map(existsSync), [uncertain, uncertain]);
    assert.equal(rejected.controlTreeUncertain, uncertain ? true : undefined);
    assert.deepEqual(providerFailure(rejected), detail ? { code: "catalog-request", detail } : undefined);
    const proof = w.messages.find((message) => message.schema === "cloud-provider-catalog-failed/v1");
    if (["unobserved-close", "hang", "prior-delete-attempt", "read-only-worker"].includes(mode)) assert.equal(proof, undefined);
    else assert.deepEqual(proof?.diagnostic, { code: "catalog-request", detail: detail ?? "request-error" });
    if (!uncertain) {
      assert.equal(w.child.exitCode, 0); assert.equal(w.child.signalCode, null);
      assert.equal(w.state().requestClose, a.calls.length); assert.equal(w.state().socketClose, a.calls.length);
      assert.equal(w.state().responseClose, a.calls.length - (mode === "reset" ? 1 : 0));
    }
  });
});

test("native account rejection requires request/response/socket close and typed terminal reply plus exit0", { timeout: 20000 }, async (t) => {
  for (const [mode, code, detail] of [["http503", "account-http"], ["invalid-json", "account-request", "invalid-json"],
    ["reset-repeat", "account-request", "request-error"], ["aborted", "account-request", "response-aborted"]]) await t.test(mode, async (t) => {
    const a = await api(t, mode), w = worker(t, a);
    const attempts = mode === "reset-repeat" ? 2 : 1;
    await assert.rejects(w.run(account, 5000), (error) => failed(error, code, detail));
    await w.run.close(); await w.run.close();
    assert.equal(w.child.exitCode, 0); assert.equal(w.child.signalCode, null);
    assert.equal(w.state().consumes, 1); assert.equal(w.state().requests, attempts); assert.equal(w.state().credentialExited, true);
    assert.equal(w.state().requestClose, attempts); assert.equal(w.state().socketClose, attempts);
    assert.equal(w.state().responseClose, mode === "reset-repeat" ? 0 : 1);
    const terminal = w.messages.find((value) => value.schema === "cloud-provider-account-failed/v2");
    assert.ok(terminal); assert.equal(terminal.disposition, "resources-closed");
    assert.equal(a.calls.length, attempts);
    await assert.rejects(w.run(account)); assert.equal(w.state().requests, attempts);
    t.diagnostic(`native ${mode}: reqClose=${w.state().requestClose} resClose=${w.state().responseClose} socketClose=${w.state().socketClose}, exit0, ${attempts} attempt(s), failed not accepted`);
  });
});

test("one native account reset retries on the pinned credential before replying", { timeout: 10000 }, async (t) => {
  const a = await api(t, "reset"), w = worker(t, a);
  const result = await w.run(account, 5000);
  assert.deepEqual(JSON.parse(result.stdout), { uuid: "synthetic-user-0001" });
  await w.run.close();
  assert.deepEqual(a.calls, Array.from({ length: 2 }, () => ({ method: "GET", path: "/v2/account" })));
  assert.equal(w.state().consumes, 1);
  assert.equal(w.state().requestClose, 2); assert.equal(w.state().socketClose, 2);
  assert.equal(w.child.exitCode, 0);
  assert.equal(w.messages.some((message) => message.schema === "cloud-provider-account-failed/v2"), false);
});

test("account retry refuses a clock rollback at request start before a second connect", async (t) => {
  const a = await api(t, "reset"), w = worker(t, a, { mode: "retry-start-rollback" });
  await assert.rejects(w.run(account, 5000), (error) => error.controlUncertain === true);
  await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
  assert.equal(w.state().retryStartRewound, true);
  assert.equal(w.state().requests, 1); assert.equal(w.state().consumes, 1);
  assert.equal(a.calls.length, 1);
  assert.equal(w.messages.some((message) => message.schema === "cloud-provider-account-failed/v2"), false);
});

test("account clock rollback at the first handoff or retry timer cannot send the request", async (t) => {
  for (const [mode, connects, gets] of [["first-handoff-rollback", 0, 0], ["retry-timer-rollback", 2, 1]]) await t.test(mode, async (t) => {
    const a = await api(t, "reset"), w = worker(t, a, { mode });
    await assert.rejects(w.run(account, 5000), (error) => error.controlUncertain === true);
    await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
    assert.equal(w.state().requests, connects); assert.equal(a.calls.length, gets);
    assert.equal(w.messages.some((message) => message.schema === "cloud-provider-account-failed/v2"), false);
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
  assert.equal(a.calls.filter((v) => v.path === "/v2/account").length, 1);
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

test("native terminal drain and cancellation after proof are distinct", { timeout: 10000 }, async (t) => {
  for (const cancelAfterProof of [false, true]) await t.test(String(cancelAfterProof), async (t) => {
    const a = await api(t, "http503"); let cancelled = false;
    const w = worker(t, a, { interrupted: () => cancelled, receive(message) {
      if (message.schema === "cloud-provider-account-failed/v2" && cancelAfterProof) queueMicrotask(() => { cancelled = true; });
      return message;
    } });
    if (cancelAfterProof) {
      await assert.rejects(w.run(account, 2000), (error) => error.controlUncertain === true);
      await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
    } else {
      await assert.rejects(w.run(account, 2000, true), (error) => failed(error, "account-http"));
      await w.run.close(); assert.equal(w.child.exitCode, 0);
      assert.equal(w.child.connected, false); assert.equal(w.child.channel, null);
    }
  });
});

test("native deadline, cancellation and unobserved resource close stay uncertain with no terminal proof", { timeout: 60000 }, async (t) => {
  for (const mode of ["hang", "cancel", "unobserved-close", "engine-clock",
    "reset-unobserved-close", "reset-engine-clock", "reset-expired", "reset-cancelled", "credential-hang"]) await t.test(mode, async (t) => {
    const a = await api(t, mode.startsWith("reset-") ? "reset" : mode); let cancel = false;
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

test("a reset after bootstrap sequence 5 does not replay provisioning", { timeout: 20000 }, async (t) => {
  const h = harness(t, { active: true });
  const remoteCalls = () => h.calls.filter(([bin]) => bin === "ssh" || bin === "scp").map((row) => JSON.stringify(row));
  let settledRows, settledCalls, approval;
  const a = await api(t, "reset", h, () => {
    const { status, control } = h.saved();
    if (status !== "preparing" || control.ledger.length !== 6 || !control.ledger.every((row) => row.localTerminal && row.code === 0)) return false;
    settledRows = control.ledger; settledCalls = remoteCalls(); return true;
  });
  const workers = [];
  const deps = { ...settlementControl(t, h), repo: h.repo, write(value) { approval = JSON.parse(value).approvalSha256; },
    providerFactory({ createMode }) { const w = worker(t, a, { createMode }); workers.push(w); return w.run; } };
  const args = ["r21", "--state-dir", h.base, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  assert.equal(await productionMain([...args, "--print-approval"], deps), 3);
  assert.equal(await productionMain([...args, "--approve-reviewed-merged-ready", approval], deps), 3);
  assert.ok(a.injected); assert.equal(settledRows.at(-1).request.sequence, 5);
  assert.deepEqual(a.calls.slice(a.firstFailure, a.firstFailure + 2), Array.from({ length: 2 }, () => ({ method: "GET", path: "/v2/account" })));
  assert.equal(a.calls.filter((row) => row.method === "POST").length, 1);
  assert.equal(a.calls.filter((row) => row.method === "DELETE").length, 0);
  assert.equal(workers[1].state().consumes, 1); assert.equal(workers[1].child.exitCode, 0);
  const saved = h.saved(), calls = remoteCalls();
  assert.equal(saved.status, "running");
  assert.deepEqual(saved.control.ledger.slice(0, 6), settledRows);
  assert.equal(saved.control.ledger[6].request.invocation.channel, "sftp");
  assert.equal(saved.control.ledger[6].code, 0);
  for (const row of new Set(settledCalls))
    assert.equal(calls.filter((call) => call === row).length, settledCalls.filter((call) => call === row).length);
  assert.equal(h.calls.filter((row) => row[0] === "ssh" && row.at(-1).startsWith("systemctl start")).length, 1);
});

test("typed proof rejects wrong nonce/sequence/grammar/version and unexpected exit", { timeout: 60000 }, async (t) => {
  for (const mode of ["nonce", "sequence", "extra", "diagnostic", "disposition", "version", "duplicate", "exit", "disconnect", "exit2", "withhold-exit", "parent-clock", "parent-clock-exit"]) await t.test(mode, async (t) => {
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
      await assert.rejects(w.run(account, 2000), (error) => error.controlUncertain === true);
      await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
    } finally { Date.now = clock; }
    assert.ok(altered); assert.equal(w.state().requests, 2);
  });
});

test("account settlement requires a clean exit strictly before the request deadline", async (t) => {
  for (const atDeadline of [false, true]) await t.test(atDeadline ? "at deadline" : "one millisecond before", async (t) => {
    const a = await api(t, "http503"), budget = 15000, start = Date.now();
    let now = start, proofAtExit = false;
    t.mock.method(Date, "now", () => now);
    // This fixture listener runs just before the controller observes the real child exit.
    const w = worker(t, a, { onExit() {
      proofAtExit = w.messages.some((m) => m.schema === "cloud-provider-account-failed/v2" && m.disposition === "resources-closed");
      now = start + budget - (atDeadline ? 0 : 1);
    } });
    a.arm(false); assert.equal((await w.run(account, budget)).status, 0); a.arm(true);
    // Only the exit handler sees the boundary; the later close check cannot substitute for it.
    w.child.once("exit", () => { now = start + budget - 1; });
    if (atDeadline) {
      await assert.rejects(w.run(account, budget), (error) => error.controlUncertain === true);
      await assert.rejects(w.run.close(), (error) => error.controlUncertain === true);
    } else {
      await assert.rejects(w.run(account, budget), (error) => failed(error, "account-http"));
      await w.run.close();
    }
    assert.ok(proofAtExit); assert.equal(w.child.exitCode, 0); assert.equal(w.child.signalCode, null);
    assert.equal(w.state().requests, 2);
  });
});

test("allocated failed account read settles before unlock, fresh pinned collect retires once with exact404", { timeout: 15000 }, async (t) => {
  const h = harness(t), a = await api(t, "invalid-json", h), workers = []; let approval;
  let locksAtWorkerExit;
  const deps = { ...settlementControl(t, h), repo: h.repo, write(value) { approval = JSON.parse(value).approvalSha256; },
    providerFactory({ createMode }) {
      const w = worker(t, a, { createMode, onExit() {
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
  const key = join(h.temp, "synthetic-verified-host-key"); writeFileSync(key, "synthetic operator-verified host key\n");
  const collect = ["r21", "--state-dir", h.base, "--collect", "--unused-bootstrap-known-hosts", key];
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
      providerFactory({ createMode }) {
        const w = worker(t, a, { createMode, mode, interrupted: () => mode === "cancel" && a.injected,
          receive: (message) => mode === "unknown" && message.schema === "cloud-provider-account-failed/v2" ? { ...message, disposition: "unknown" } : message });
        workers.push(w);
        const run = (args, timeout, ...rest) => w.run(args, Math.min(timeout, 2000), ...rest);
        run.close = w.run.close; return run;
      } };
    const args = mode === "delete" ? ["r21", "--state-dir", h.base, "--collect"]
      : ["r21", "--state-dir", h.base, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
    const approved = async (args) => {
      assert.equal(await productionMain([...args, "--print-approval"], deps), 3);
      return productionMain([...args, "--approve-reviewed-merged-ready", approval], deps);
    };
    await assert.rejects(approved(args), (error) => {
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
    const before = h.calls.length, providerBefore = a.calls.length, saved = h.saved();
    const locks = [join(h.local, "operation.lock"), ...(mode === "delete" ? [] : [join(h.base, ".groups-launch.lock")])];
    const custody = locks.map((path) => readFileSync(path));
    const collect = ["r21", "--state-dir", h.base, "--collect"];
    if (["action", "post"].includes(mode)) {
      // The unbound create is refused before collect can try the operation lock. A pending
      // action keeps the POST's IDs for a later recheck, which refuses while the launch's
      // locks remain, before any provider read.
      assert.deepEqual(saved.createPending, mode === "action" ? { dropletId: "123", actionId: "456" } : undefined);
      await assert.rejects(approved(collect), { controllerStage: "controller-collect", message: mode === "action"
        ? /original launch custody retained/ : /monitor not registered; preserve pending reservation/ });
      await assert.rejects(approved(args), { controllerStage: "controller-launch", code: "EEXIST" });
    } else await assert.rejects(approved(collect), { controllerStage: "controller-collect", code: "EEXIST" });
    assert.ok(workers.slice(2).every((w) => w.child === undefined));
    assert.deepEqual(h.calls.slice(before).filter(([binary]) => binary !== "git"), []);
    assert.equal(a.calls.length, providerBefore);
    assert.deepEqual(h.saved(), saved);
    assert.deepEqual(locks.map((path) => readFileSync(path)), custody);
    await assert.rejects(workers[1].run.close(), (error) => error.controlUncertain === true);
    t.diagnostic(`${mode}: sticky uncertainty + retained operation lock; no repeated mutation`);
  });
});
