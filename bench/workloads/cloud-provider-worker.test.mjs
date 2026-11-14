import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import * as provider from "./cloud-provider.mjs";
import { productionMain } from "./cloud-production.mjs";
import { publicError } from "./droplet.mjs";
import { providerDiagnostic } from "./cloud-options.mjs";
import { accountId, campaign, commit, context, harness as controllerHarness, subject, syntheticDelivery } from "./cloud-fixtures.mjs";

const account = ["account", "get", "--output", "json", "--context", "synthetic-worker-context"];
function harness(t, mode = "success", transform = (value) => value, interrupted = () => false, receive = (value) => value) {
  const root = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), output = join(root, "observation.json");
  let child, tokenIPC = false, launches = 0;
  const run = provider.providerTransport({ repo: resolve("."), interrupted, launch(path, args, options) {
    launches++; assert.equal(path, realpathSync(process.execPath)); assert.equal(args.length, 3);
    assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-"]); assert.ok(args[2].endsWith("cloud-provider-worker.mjs"));
    assert.deepEqual(options.execArgv, []); assert.equal(options.stdio[0], "pipe");
    assert.equal(options.stdio[1], "ignore"); assert.equal(options.stdio[2], "ignore");
    assert.ok(!Object.keys(options.env).some((name) => /^(?:NODE_|SSL|OPENSSL|LD_|DYLD_)/i.test(name)));
    child = fork(fileURLToPath(new URL("cloud-provider-test-worker.mjs", import.meta.url)), [mode, output], options);
    const emit = child.emit.bind(child);
    child.emit = (name, ...args) => emit(name, ...(name === "message" ? [receive(args[0]), ...args.slice(1)] : args));
    child.on("message", (value) => { tokenIPC ||= JSON.stringify(value).includes("SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL"); });
    const send = child.send.bind(child); child.send = (message, callback) => send(transform(message), callback);
    return child;
  } });
  t.after(async () => {
    try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); }
    assert.equal(tokenIPC, false); rmSync(root, { recursive: true, force: true });
  });
  return { run, state: () => JSON.parse(readFileSync(output)), get child() { return child; }, get launches() { return launches; } };
}

test("clean worker uses one immutable private credential across account/create/action/list/delete", async (t) => {
  const h = harness(t);
  assert.equal(JSON.parse((await h.run(account)).stdout).uuid, "synthetic-user-0001");
  const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo2", "--image", "ubuntu-24-04-x64",
    "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...account.slice(-2)];
  await h.run(create); await h.run(["compute", "droplet", "list", "--output", "json", ...account.slice(-2)]);
  await h.run(["compute", "droplet", "delete", "123", "--force", ...account.slice(-2)]);
  const state = h.state(); assert.equal(state.consumes, 1); assert.equal(state.requests, 5); assert.equal(h.launches, 1);
  assert.deepEqual(state.calls.map((value) => value.method), ["GET", "POST", "GET", "GET", "DELETE"]);
  assert.ok(state.calls.every((value) => value.originalCredential));
  await h.run.close(); assert.notEqual(h.child.exitCode, null);
  await assert.rejects(h.run(account));
});

test("strict worker grammar/source handshake refuses URL/sequence/context changes without fallback", async (t) => {
  for (const kind of ["url", "sequence", "source", "extra", "context"]) await t.test(kind, async (t) => {
    const h = harness(t, "success", (message) => {
      if (kind === "source" && message.sources) return { ...message, sources: message.sources.map((value) => ({ ...value, sha256: "0".repeat(64) })) };
      if (message.schema !== "cloud-provider-action/v1") return message;
      if (kind === "url") return { ...message, args: ["GET", "https://synthetic.invalid"] };
      if (kind === "sequence") return { ...message, sequence: 9 };
      if (kind === "extra") return { ...message, providerURL: "https://synthetic.invalid" };
      return message;
    });
    if (kind === "context") { await h.run(account); await assert.rejects(h.run([...account.slice(0, -1), "synthetic-other-context"])); }
    else await assert.rejects(h.run(account), (error) => error.controlTreeUncertain === true);
    assert.equal(h.state().consumes, kind === "context" ? 1 : 0);
    assert.equal(h.state().requests, kind === "context" ? 1 : 0);
    assert.equal(h.launches, 1); await assert.rejects(h.run(account));
  });
});

test("provider response reflecting a token never crosses IPC", async (t) => {
  const h = harness(t, "reflect"); await assert.rejects(h.run(account), (error) => error.controlUncertain === true);
  assert.equal(h.state().consumes, 1); assert.equal(h.state().requests, 1);
});

test("bounded create classifications survive real worker IPC and cached teardown to public output", async (t) => {
  for (const [mode, diagnostic, requests] of [
    ["post-link-failure", { code: "create-link" }, 1],
    ["first-action-invalid", { code: "create-action-response" }, 2],
    ["pending-create", { code: "create-action-pending" }, 2],
    ["first-action-http-failure", { code: "create-action-http", httpStatus: 403 }, 2],
  ]) await t.test(mode, async (t) => {
    const h = harness(t, mode);
    const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo2", "--image", "ubuntu-24-04-x64",
      "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...account.slice(-2)];
    const check = (error) => {
      assert.equal(error.controlTreeUncertain, true); assert.equal(error.controlUncertain, true);
      assert.deepEqual(error.providerDiagnostic, diagnostic);
      const output = publicError(error);
      assert.ok(output.includes(`Provider failure: ${diagnostic.code}`));
      assert.equal(output.includes("HTTP 403"), diagnostic.httpStatus === 403);
      assert.ok(!`${output}${error.stack}${JSON.stringify(error)}`.includes("SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL"));
      return true;
    };
    await assert.rejects(h.run(create, 500), check);
    await assert.rejects(h.run.close(), check); await assert.rejects(h.run.close(), check);
    assert.equal(h.state().requests, requests); assert.equal(h.launches, 1);
    assert.ok(h.child.exitCode !== null || h.child.signalCode !== null);
  });
});

test("unknown, extra or non-table IPC diagnostic values fail closed without public reflection", async (t) => {
  const raw = "SYNTHETIC_RAW_BODY";
  for (const result of [{ code: raw }, { code: "create-link", raw }, { code: "create-action-http", httpStatus: raw },
    { code: "create-action-http", httpStatus: 499 }, { code: "create-link", httpStatus: 403 }, ["create-link"]]) {
    const h = harness(t, "reflect", undefined, undefined, (message) => message.ok === false ? { ...message, result } : message);
    await assert.rejects(h.run(account), (error) => {
      assert.equal(error.controlUncertain, true); assert.equal(error.providerDiagnostic, undefined);
      assert.ok(!publicError(error).includes(raw)); return true;
    });
    assert.equal(h.launches, 1);
  }
});

test("public errors only format the closed diagnostic table, never native error fields or getters", () => {
  const raw = "SYNTHETIC_RAW_BODY", base = publicError();
  const native = Object.assign(new Error(raw), { code: raw, status: 403, body: raw });
  assert.equal(publicError(native), base);
  for (const value of [null, { code: raw }, { code: "create-link", raw }, { code: "create-action-http", httpStatus: 499 },
    { code: "create-link", httpStatus: 403 }, { get code() { throw new Error(raw); } }]) {
    assert.equal(providerDiagnostic(value), undefined);
    assert.equal(publicError(Object.assign(native, { providerDiagnostic: value })), base);
  }
  Object.defineProperty(native, "providerDiagnostic", { get() { throw new Error(raw); } });
  assert.equal(publicError(native), base);
  assert.deepEqual(providerDiagnostic({ code: "create-action-http", httpStatus: 403 }), { code: "create-action-http", httpStatus: 403 });
});

test("permitted HTTP failure carries only its diagnostic and leaves the worker usable", async (t) => {
  const h = harness(t, "first-action-http-failure");
  const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo2", "--image", "ubuntu-24-04-x64",
    "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...account.slice(-2)];
  assert.deepEqual(await h.run(create, 1000, true), { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "create-action-http", httpStatus: 403 } });
  assert.equal((await h.run(account)).status, 0); await h.run.close();
  assert.equal(h.state().consumes, 1); assert.equal(h.launches, 1);
});

test("success IPC cannot smuggle diagnostics, unknown fields or nonempty failed output", async (t) => {
  for (const result of [
    { status: 0, stdout: "", stderr: "", providerDiagnostic: { code: "create-http", httpStatus: 403 } },
    { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "SYNTHETIC_RAW_BODY" } },
    { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "create-http", httpStatus: 499 } },
    { status: 1, stdout: "SYNTHETIC_RAW_BODY", stderr: "", providerDiagnostic: { code: "create-http", httpStatus: 403 } },
    { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "create-http", httpStatus: 403 }, raw: "SYNTHETIC_RAW_BODY" },
  ]) {
    const h = harness(t, "success", undefined, undefined, (message) => message.ok && message.result?.status === 0 ? { ...message, result } : message);
    await assert.rejects(h.run(account), (error) => {
      assert.equal(error.controlTreeUncertain, true); assert.equal(error.providerDiagnostic, undefined);
      assert.ok(!publicError(error).includes("SYNTHETIC_RAW_BODY")); return true;
    });
    assert.equal(h.launches, 1);
  }
});

test("deadline and cancellation reap an unsettled worker, preserve uncertainty and never retry", async (t) => {
  for (const cancel of [false, true]) await t.test(cancel ? "cancel" : "deadline", async (t) => {
    let interrupted = false;
    const h = harness(t, "hang", undefined, () => interrupted);
    const running = h.run(account, cancel ? 5000 : 100);
    const timer = cancel ? setTimeout(() => { interrupted = true; }, 300) : undefined;
    try { await assert.rejects(running, (error) => error.controlTreeUncertain === true && error.controlUncertain === true); }
    finally { clearTimeout(timer); }
    assert.ok(h.child.exitCode !== null || h.child.signalCode !== null); assert.equal(h.launches, 1);
    await assert.rejects(h.run(account));
  });
});

test("parent disconnect reaps its idle credential worker", async (t) => {
  const h = harness(t); await h.run(account);
  const exit = once(h.child, "exit"); h.child.disconnect();
  let timer;
  try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned worker did not exit")), 2000); })]); }
  finally { clearTimeout(timer); }
  assert.notEqual(h.child.exitCode, null);
});

test("controller exposes no direct credential-taking REST constructor", () => {
  assert.equal(provider.restRequest, undefined);
});

test("approved productionMain reaps the actual clean worker and retains locks for uncertain create", async (t) => {
  for (const mode of ["success", "hang-create", "withhold-close", "post-link-failure", "first-action-http-failure", "zero-resource-create", "create-http-failure"]) await t.test(mode, async (t) => {
  const h = controllerHarness(t), workers = [];
  let approval;
  const interrupted = () => {
    if (mode !== "hang-create" || !workers[1]) return false;
    try { return workers[1].state().calls.some((value) => value.method === "POST"); } catch { return false; }
  };
  const deps = { repo: h.repo, interrupted, sleep: async () => {}, inspect: async () => h.report(), write(value) { approval = JSON.parse(value).approvalSha256; },
    providerFactory({ interrupted }) { const w = harness(t, mode, undefined, interrupted); workers.push(w); return w.run; },
    spawn(binary, argv, options) {
      assert.notEqual(binary, "doctl", "parent must never consume a provider credential");
      if (binary === "git" && argv[0] === "show") return { status: 0, stdout: readFileSync(resolve(argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n") };
      const args = [...argv];
      if (binary === "ssh") args[args.length - 1] = options.input.replace(/^set -euo pipefail\n/, "").replace(/\n$/, "");
      const result = h.run(binary, args, options.timeout);
      if (binary === "ssh" && args.at(-1).startsWith("systemctl show"))
        result.stdout = result.stdout.replaceAll(/corten-bench-groups-r21-[a-f0-9]{16}\.service/g, h.saved().unit);
      return result;
    } };
  const args = ["r21", "--state-dir", h.base, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  assert.equal(await productionMain([...args, "--print-approval"], deps), 3);
  assert.equal(workers[0].launches, 0);
  const launched = productionMain([...args, "--approve-reviewed-merged-ready", approval], deps);
  const completed = ["success", "first-action-http-failure", "zero-resource-create"].includes(mode);
  if (completed) assert.equal(await launched, 3);
  else await assert.rejects(launched, (error) => {
    assert.equal(error.controlTreeUncertain === true, mode !== "create-http-failure");
    if (mode === "post-link-failure") {
      assert.deepEqual(error.providerDiagnostic, { code: "create-link" });
      assert.ok(publicError(error).includes("Provider failure: create-link."));
    }
    if (mode === "create-http-failure") {
      assert.deepEqual(error.providerDiagnostic, { code: "create-http", httpStatus: 422 });
      assert.ok(publicError(error).includes("Provider failure: create-http (HTTP 422)."));
    }
    return true;
  });
  const worker = workers[1]; assert.equal(worker.state().consumes, 1);
  assert.equal(worker.state().calls.filter((value) => value.method === "POST").length, 1);
  const earlyFailure = ["hang-create", "post-link-failure", "create-http-failure"].includes(mode);
  assert.equal(h.saved().status, earlyFailure ? "creating" : "running");
  if (earlyFailure) {
    assert.equal(Object.hasOwn(h.saved(), "id"), false);
    assert.equal(h.calls.some(([binary]) => binary === "ssh" || binary === "scp"), false);
    assert.equal(worker.state().calls.filter(({ path }) => path === "/v2/actions/456").length, 0);
  }
  if (mode === "first-action-http-failure" || mode === "zero-resource-create")
    assert.equal(worker.state().calls.filter(({ path }) => path === "/v2/actions/456").length, mode === "zero-resource-create" ? 2 : 1);
  assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null);
  if (!completed && mode !== "create-http-failure") {
    assert.ok(existsSync(join(h.local, "operation.lock"))); assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
  } else {
    assert.equal(existsSync(join(h.local, "operation.lock")), false); assert.equal(existsSync(join(h.base, ".groups-launch.lock")), false);
  }
  });
});

test("unlisted future executable imports are denied before evaluation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), directory = join(root, "bench", "workloads"), marker = join(root, "synthetic-executed.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of provider.providerFiles) {
    const target = resolve(directory, name); mkdirSync(resolve(target, ".."), { recursive: true });
    copyFileSync(fileURLToPath(new URL(name, new URL("./", import.meta.url))), target);
  }
  writeFileSync(join(directory, "synthetic-unlisted.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '{}'); process.exit(2);\n`);
  appendFileSync(join(directory, "cloud-provider-engine.mjs"), "\nimport './synthetic-unlisted.mjs';\n");
  const staged = await import(pathToFileURL(join(directory, "cloud-provider.mjs")).href), run = staged.providerTransport({ repo: root });
  try { await assert.rejects(run(account)); }
  finally { try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); } }
  assert.equal(existsSync(marker), false);
});

test("entry snapshot cannot execute a disk replacement after the parent's final hash", async (t) => {
  for (const mode of ["ordinary", "replace-entry"]) await t.test(mode, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), directory = join(root, "bench", "workloads"), marker = join(root, "synthetic-entry-executed.json");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const name of provider.providerFiles) {
      const target = resolve(directory, name); mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(fileURLToPath(new URL(name, new URL("./", import.meta.url))), target);
    }
    // Test-only source dependency, never a production flag/IPC override. The
    // actual native entry/IPC/load gate run, with no possible real store access.
    writeFileSync(join(directory, "cloud-provider-engine.mjs"), `export function createProviderEngine() { return async () => ({ status: 0, stdout: JSON.stringify({uuid:'synthetic-entry-positive'}), stderr:'' }); }\n`);
    const staged = await import(pathToFileURL(join(directory, "cloud-provider.mjs")).href);
    const run = staged.providerTransport({ repo: root, ...(mode === "replace-entry" ? { launch(program, args, options) {
      const entry = args[0] === "--input-type=module" ? args[2] : program;
      writeFileSync(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '{}'); process.exit(2);\n`);
      return args[0] === "--input-type=module" ? spawn(program, args, options) : fork(program, args, options);
    } } : {}) });
    try {
      if (mode === "ordinary") assert.equal(JSON.parse((await run(account)).stdout).uuid, "synthetic-entry-positive");
      else await assert.rejects(run(account), (error) => error.controlTreeUncertain === true);
    } finally { try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); } }
    assert.equal(existsSync(marker), false, "replaced bootstrap disk bytes must never execute");
  });
});

test("settlement remains inside the operation lock for collect early returns, errors and audit actions", async (t) => {
  for (const mode of ["running-collect", "terminal-collect", "error-collect", "audit", "error-audit"]) await t.test(mode, async (t) => {
    const h = controllerHarness(t, { ...(mode === "running-collect" ? { active: true } : {}),
      ...(mode === "error-collect" ? { listError: true } : {}), ...(mode === "error-audit" ? { auditCollision: true } : {}) }); h.seed();
    let settled = 0;
    const task = h.task({ settle: async () => {
      settled++; assert.ok(existsSync(join(h.local, "operation.lock")));
      throw Object.assign(new Error("synthetic teardown uncertainty"), { controlTreeUncertain: true });
    } }, mode.includes("audit") ? { collect: undefined, deliverAudit: join(h.temp, "synthetic-delivery.json"), campaign, approveSubject: subject } : {});
    if (mode.includes("audit")) writeFileSync(join(h.temp, "synthetic-delivery.json"), JSON.stringify(syntheticDelivery()));
    await assert.rejects(mode.includes("audit") ? task.deliverAudit() : task.collect(), (error) => error.controlTreeUncertain === true);
    assert.equal(settled, 1); assert.ok(existsSync(join(h.local, "operation.lock")));
  });
});

test("every executable dependency is bound before any changed dependency can run", async (t) => {
  const dependencies = ["../catalog/droplet-contract.mjs", "../catalog/contract.mjs", "../catalog/group.mjs", "../fullstack/passes.mjs",
    "../fullstack/inventory.mjs", "../marketplace/contract.mjs", "registry.mjs"];
  for (const dependency of dependencies) await t.test(dependency, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), directory = join(root, "bench", "workloads"), marker = join(root, "synthetic-executed.json");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const name of new Set([...provider.providerFiles, ...dependencies])) {
      const target = resolve(directory, name); mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(fileURLToPath(new URL(name, new URL("./", import.meta.url))), target);
    }
    const staged = await import(pathToFileURL(join(directory, "cloud-provider.mjs")).href);
    appendFileSync(resolve(directory, dependency), `\nimport { writeFileSync as __syntheticClosureMarkerWrite } from 'node:fs';\n__syntheticClosureMarkerWrite(${JSON.stringify(marker)}, '{}'); process.exit(2);\n`);
    const run = staged.providerTransport({ repo: root });
    try { await assert.rejects(run(account)); }
    finally { try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); } }
    assert.equal(existsSync(marker), false, "unbound executable bytes must never run");
  });
});
