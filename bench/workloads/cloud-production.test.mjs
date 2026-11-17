import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { accountId, commit, context, harness, syntheticDelivery, syntheticProviderRequest } from "./cloud-fixtures.mjs";
import { controllerPaths, nativePaths, parseProductionArgs, productionMain } from "./cloud-production.mjs";
import { createProviderEngine } from "./cloud-engine-test-fixture.mjs";
import { fleetPlan } from "./cloud-contract.mjs";
import { groupNames } from "./registry.mjs";
import { sourceUrl } from "./cloud-remote.mjs";
import { registration as streamRegistration } from "./test-fixtures/control-stream-fixture.mjs";
import { controlRegistration } from "./cloud-control-runtime.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { digest } from "./cloud-local.mjs";

function productionHarness(t, flags = {}) {
  const h = harness(t, flags), calls = [], stdout = [];
  const spawn = (binary, argv, options) => {
    calls.push([binary, argv, options]);
    if (binary === "git") {
      if (argv[0] === "show") {
        const path = argv[1].slice(41);
        return { status: 0, stdout: flags.wrongSource ? "wrong" : readFileSync(resolve(path), "utf8").replaceAll("\r\n", "\n") };
      }
      if (argv[0] === "cat-file" && flags.missingNative) return { status: 1, stderr: "private" };
      if (argv[0] === "merge-base" && flags.unmerged) return { status: 1, stderr: "private" };
      if (argv[0] === "merge-base" && flags.staleTracking && argv.at(-1) === "origin/main") return { status: 1, stderr: "private" };
      if (argv[0] === "fetch" && flags.fetchError) return { status: 1, stderr: "private" };
      if (argv[0] === "fetch" && flags.afterFetch) flags.afterFetch();
      if (argv[0] === "status" && flags.dirty) return { status: 0, stdout: " M private-file" };
      if (argv[0] === "status" && existsSync(join(h.local, "audit-delivery.lock"))) flags.underAuditLock?.();
      return h.run(binary, argv, options.timeout);
    }
    const args = [...argv];
    if (binary === "doctl") args.splice(args.indexOf("--http-retry-max"));
    const request = existsSync(h.statePath) ? h.saved().control?.ledger.at(-1)?.request : undefined;
    if (binary === "ssh") {
      const control = request && controlRegistration(request);
      if (control) assert.equal(argv.at(-1), control.command);
      const input = control ? options.input.slice(control.inputPrefix.length) : options.input;
      args[args.length - 1] = input.replace(/^set -euo pipefail\n/, "").replace(/\n$/, "");
    }
    if (binary === "sftp") {
      assert.equal(argv.at(-2), controlRegistration(request).command);
      const batch = /^(get|put) "((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)"\n$/.exec(options.input);
      assert.ok(batch); const a = batch[2].replace(/\\(.)/g, "$1"), b = batch[3].replace(/\\(.)/g, "$1");
      const pair = batch[1] === "get" ? [argv.at(-1) + ":" + a, b] : [a, argv.at(-1) + ":" + b];
      const result = h.run("scp", pair, options.timeout);
      return { ...result, stderr: "CORTEN_CONTROL " + request.invocation.id + " " + "d".repeat(64) + "\nCORTEN_RESULT " + request.invocation.id + " " + result.status + "\n" };
    }
    if (flags.uploadHashError && binary === "ssh" && args.at(-1).includes("sha256sum --check")) return { status: 1, stderr: "private" };
    const result = flags.sealFail && binary === "ssh" && args.at(-1) === ":"
      ? { status: 1, stdout: "", stderr: "" } : h.run(binary, args, options.timeout);
    return request && binary === "ssh" ? { ...result, stderr: "CORTEN_CONTROL " + request.invocation.id + " " + "d".repeat(64) + "\nCORTEN_RESULT " + request.invocation.id + " " + result.status + "\n" } : result;
  };
  const deps = { spawn, providerRequest: syntheticProviderRequest(h, (binary, argv, timeout) => {
    calls.push([binary, argv, { timeout }]); return h.run(binary, argv, timeout, true);
  }), repo: h.repo, inspect: async () => h.report(), sleep: async () => {}, interrupted: () => flags.cancelled, write: (v) => stdout.push(JSON.parse(v)) };
  deps.streamSpawn = (binary, argv) => {
    assert.equal(binary, "ssh"); const child = new EventEmitter(), expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex"));
    let sequence = 0, ended = false;
    const frame = (kind, payload) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: expected.id, sequence: ++sequence, kind, payload }) + "\n");
    const close = (code) => { if (!ended) { ended = true; child.emit("close", code, null); } };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) { if (JSON.parse(bytes).kind === "close") setImmediate(() => close(0)); next(); } });
    child.stdin.on("close", () => setImmediate(() => close(255)));
    setImmediate(() => { frame("registered", { ...structuredClone(streamRegistration), binding: expected.binding, id: expected.id }); frame("progress", { state: "active" }); });
    const deadline = Date.now() + 2000, timer = setInterval(() => {
      if (h.saved().control.sealed.includes("bootstrap")) { clearInterval(timer); frame("terminal", { id: expected.id,
        nativeTerminal: true, campaign: "r21-0123456789abcdef", sealSha256: "f".repeat(64) }); }
      else if (Date.now() > deadline) { clearInterval(timer); close(255); }
    }, 5);
    t.after(() => { clearInterval(timer); close(255); }); return child;
  };
  deps.providerFactory = ({ repo, interrupted }) => Object.assign(createProviderEngine({ repo, interrupted, spawn, request: deps.providerRequest, sleep: deps.sleep }), { close: async () => {} });
  const args = (mode = "--collect") => ["r21", "--state-dir", h.base, mode, ...(mode === "--detach" ? ["--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context] : [])];
  async function approve(mode) { const values = args(mode); await productionMain([...values, "--print-approval"], deps); return [...values, "--approve-reviewed-merged-ready", stdout.at(-1).approvalSha256]; }
  return { h, calls, stdout, deps, args, approve };
}

async function supervisedAudit(t, group, flags = {}) {
  flags.active = true;
  const p = productionHarness(t, flags), prefix = group === "json-api" ? "json" : "mixed", campaign = "r21-0123456789abcdef";
  const delivery = syntheticDelivery(group), identities = delivery.bundle.receipts.map((r) => r.identity);
  if (group === "json-api") delivery.bundle.schema = "json-api-native-audits/v2";
  const body = { schema: "benchmark-" + prefix + "-audit-subject/v1", commit, campaignSha256: "f".repeat(64),
    ...(group === "json-api" ? { identities } : { requests: identities.map((identity) => ({ identity })) }) };
  const subjectSha256 = deploymentSha256(body), subject = Buffer.from(JSON.stringify({ ...body, subjectSha256 }));
  delivery.subjectSha256 = subjectSha256; delivery.review.subjectSha256 = subjectSha256;
  const path = join(p.h.temp, "approved-delivery.json"); writeFileSync(path, JSON.stringify(delivery));
  const input = []; let finish, started = 0;
  p.deps.streamSpawn = (binary, argv) => {
    assert.equal(binary, "ssh"); started++;
    const expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex")), child = new EventEmitter();
    let sequence = 0, closed = false;
    const frame = (kind, payload) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: expected.id, sequence: ++sequence, kind, payload }) + "\n");
    const close = (code) => { if (!closed) { closed = true; child.emit("close", code, null); } };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) {
      const value = JSON.parse(bytes); input.push(value);
      if (value.kind === "close") setImmediate(() => close(0));
      if (value.kind === "delivery-end") frame("delivery-sealed", { group, campaign, subjectSha256 });
      next();
    } });
    child.stdin.on("close", () => setImmediate(() => close(255)));
    setImmediate(() => { frame("registered", { ...structuredClone(streamRegistration), binding: expected.binding, id: expected.id }); frame("progress", { state: "active" }); });
    finish = () => frame("terminal", { id: expected.id, nativeTerminal: true, campaign, sealSha256: "f".repeat(64) });
    const timer = setInterval(() => {
      if (!p.h.saved().control.sealed.includes("bootstrap")) return;
      clearInterval(timer); frame("audit-begin", { campaign, group, subjectSha256 });
      frame("audit-file", { group, path: prefix + "-audit-subject.json", bytes: subject.length, sha256: digest(subject) });
      frame("audit-data", { offset: 0, data: subject.toString("base64") }); frame("audit-file-end", {}); frame("audit-end", { group, subjectSha256 });
    }, 5);
    t.after(() => { clearInterval(timer); close(255); }); return child;
  };
  const pending = productionMain(await p.approve("--detach"), p.deps);
  const wait = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) { assert.ok(Date.now() < deadline, "bounded audit stream wait"); await new Promise((r) => setTimeout(r, 5)); }
  };
  await wait(() => existsSync(join(p.h.local, "monitor-audit-" + group + "-ready.json")));
  const args = ["r21", "--state-dir", p.h.base, "--deliver-audit", path, "--audit-group", group, "--campaign", campaign, "--approve-subject", subjectSha256];
  const approve = async () => {
    await productionMain([...args, "--print-approval"], p.deps);
    return [...args, "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256];
  };
  return { ...p, path, input, wait, approve, started: () => started, finish: async () => { finish(); await pending; } };
}

test("supervised approved audit delivery uses locked production approval and the existing stream for JSON and mixed", async (t) => {
  for (const group of ["json-api", "mixed-production"]) {
    const flags = {}, p = await supervisedAudit(t, group, flags); let checked = 0;
    try {
      const approval = await p.approve(), calls = p.calls.length;
      flags.underAuditLock = () => { checked++; assert.ok(existsSync(join(p.h.local, "operation.lock"))); };
      assert.equal(await productionMain(approval, p.deps), 3); assert.equal(checked, 1);
      await p.wait(() => p.input.some((v) => v.kind === "delivery-end"));
      const frames = p.input.filter((v) => v.kind.startsWith("delivery-"));
      assert.deepEqual(frames.map((v) => v.kind), ["delivery-begin", "delivery-data", "delivery-end"]);
      assert.equal(Buffer.from(frames[1].payload.data, "base64").toString(), readFileSync(p.path, "utf8"));
      assert.equal(p.started(), 1); assert.ok(p.calls.slice(calls).every(([binary]) => binary === "git"));
      assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
      assert.ok(!existsSync(join(p.h.local, "audit-delivery.lock")));
      await assert.rejects(productionMain(approval, p.deps), /already queued/);
      assert.equal(p.input.filter((v) => v.kind === "delivery-begin").length, 1);
    } finally { await p.finish(); }
    assert.ok(!existsSync(join(p.h.local, "operation.lock")));
  }
});

test("supervised audit rejects a stale explicit action approval before any publication", async (t) => {
  const p = await supervisedAudit(t, "json-api");
  try {
    const approval = await p.approve(), calls = p.calls.length;
    const value = JSON.parse(readFileSync(p.path)); value.review.reviewer = "replaced reviewer";
    writeFileSync(p.path, JSON.stringify(value));
    await assert.rejects(productionMain(approval, p.deps), /explicit operator-approved exact action/);
    assert.ok(!existsSync(join(p.h.local, "monitor-delivery-json-api.json")));
    assert.ok(p.calls.slice(calls).every(([binary]) => binary === "git"));
    assert.equal(p.input.filter((v) => v.kind.startsWith("delivery-")).length, 0);
  } finally { await p.finish(); }
});

test("supervised audit rechecks replacement delivery and reservation under its exclusive lock", async (t) => {
  for (const group of ["json-api", "mixed-production"]) for (const replaced of ["delivery", "reservation"]) {
    const flags = {}, p = await supervisedAudit(t, group, flags);
    try {
      const approval = await p.approve(), calls = p.calls.length;
      flags.underAuditLock = () => {
        flags.underAuditLock = undefined;
        assert.ok(existsSync(join(p.h.local, "operation.lock")));
        if (replaced === "delivery") {
          const value = JSON.parse(readFileSync(p.path)); value.review.reviewer = "replaced after preflight";
          writeFileSync(p.path, JSON.stringify(value));
        } else p.h.change((s) => { s.auditIntents = {}; });
      };
      await assert.rejects(productionMain(approval, p.deps), /locked action changed after approval/);
      assert.ok(!existsSync(join(p.h.local, "monitor-delivery-" + group + ".json")));
      assert.ok(!existsSync(join(p.h.local, "audit-delivery.lock")));
      assert.ok(existsSync(join(p.h.local, "operation.lock")));
      assert.equal(p.started(), 1); assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
      assert.ok(p.calls.slice(calls).every(([binary]) => binary === "git"));
      assert.equal(p.input.filter((v) => v.kind.startsWith("delivery-")).length, 0);
    } finally { await p.finish(); }
  }
});

test("supervised audit refuses a competing publication lock without touching live monitor custody", async (t) => {
  const p = await supervisedAudit(t, "mixed-production");
  try {
    const approval = await p.approve();
    writeFileSync(join(p.h.local, "audit-delivery.lock"), "competing approved publisher");
    await assert.rejects(productionMain(approval, p.deps), /EEXIST/);
    assert.equal(readFileSync(join(p.h.local, "audit-delivery.lock"), "utf8"), "competing approved publisher");
    assert.ok(existsSync(join(p.h.local, "operation.lock")));
    assert.ok(!existsSync(join(p.h.local, "monitor-delivery-mixed-production.json")));
    assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  } finally { await p.finish(); }
});

test("supervised audit never consumes or replaces an interrupted pending publication", async (t) => {
  const p = await supervisedAudit(t, "mixed-production");
  try {
    const approval = await p.approve(), target = join(p.h.local, "monitor-delivery-mixed-production.json");
    writeFileSync(target + ".pending", "interrupted publisher evidence");
    await assert.rejects(productionMain(approval, p.deps), /EEXIST/);
    assert.ok(!existsSync(target)); assert.equal(readFileSync(target + ".pending", "utf8"), "interrupted publisher evidence");
    assert.ok(!existsSync(join(p.h.local, "audit-delivery.lock"))); assert.ok(existsSync(join(p.h.local, "operation.lock")));
    assert.equal(p.input.filter((v) => v.kind.startsWith("delivery-")).length, 0);
    assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  } finally { await p.finish(); }
});

test("supervised audit settlement uncertainty retains both locks and never repeats a queued delivery", async (t) => {
  const flags = {}, p = await supervisedAudit(t, "json-api", flags), factory = p.deps.providerFactory;
  let fail = false, closed = 0;
  p.deps.providerFactory = (options) => {
    const run = factory(options);
    run.close = async () => { closed++; if (fail) throw Object.assign(new Error("synthetic unsettled control"), { controlTreeUncertain: true, controlUncertain: true }); };
    return run;
  };
  try {
    const approval = await p.approve(); closed = 0;
    flags.underAuditLock = () => { fail = true; };
    await assert.rejects(productionMain(approval, p.deps), (error) => error.controlTreeUncertain && error.controlUncertain && error.controllerStage === "provider-settlement");
    assert.equal(closed, 2); assert.ok(existsSync(join(p.h.local, "audit-delivery.lock")));
    assert.ok(existsSync(join(p.h.local, "operation.lock")));
    assert.ok(existsSync(join(p.h.local, "monitor-delivery-json-api.json")));
    fail = false; flags.underAuditLock = undefined;
    await assert.rejects(productionMain(approval, p.deps), /EEXIST/);
    await p.wait(() => p.input.some((v) => v.kind === "delivery-end"));
    assert.equal(p.input.filter((v) => v.kind === "delivery-begin").length, 1);
    assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  } finally { await p.finish(); }
});

test("production entry forwards source-bound stream registration and settles asynchronous stream failure without dropping custody", async (t) => {
  const p = productionHarness(t, { active: true }); let started = 0, closed = 0;
  const originalFactory = p.deps.providerFactory;
  p.deps.providerFactory = (options) => { const run = originalFactory(options); run.close = async () => { closed++; }; return run; };
  p.deps.streamSpawn = (binary, argv, options) => {
    started++; assert.equal(binary, "ssh"); assert.equal(options.shell, false); assert.equal(options.cwd, p.h.repo);
    const expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex"));
    assert.equal(expected.id, p.h.saved().control.monitor.id); assert.equal(expected.binding.helperSha256, p.h.saved().control.helperSha256);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) { next(); } });
    child.stdin.on("close", () => setImmediate(() => child.emit("close", 255, null)));
    setImmediate(() => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: expected.id, sequence: 2,
      kind: "registered", payload: { ...structuredClone(streamRegistration), binding: expected.binding, id: expected.id } }) + "\n"));
    return child;
  };
  const approval = await p.approve("--detach"); closed = 0;
  await assert.rejects(productionMain(approval, p.deps), (error) => error.controlTreeUncertain === true && error.controllerStage === "controller-launch");
  assert.equal(started, 1); assert.equal(closed, 2);
  assert.ok(existsSync(join(p.h.local, "operation.lock"))); assert.ok(existsSync(join(p.h.base, ".groups-launch.lock")));
  assert.ok(existsSync(join(p.h.local, "monitor-invalid.json"))); assert.equal(p.h.deletes, 0);
});

test("production entry keeps the single stream alive through bootstrap seal and awaits local close before teardown", async (t) => {
  const p = productionHarness(t, { active: true }); let started = 0, streamClosed = false, providerClosed = 0;
  p.deps.streamSpawn = (binary, argv) => {
    started++; assert.equal(binary, "ssh");
    const expected = JSON.parse(Buffer.from(argv.at(-1).split(" ").at(-1), "hex")), child = new EventEmitter(); let sequence = 0;
    const frame = (kind, payload) => child.stdout.write(JSON.stringify({ schema: "benchmark-control-frame/v1", id: expected.id, sequence: ++sequence, kind, payload }) + "\n");
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, next) {
      if (JSON.parse(bytes).kind === "close") setImmediate(() => { streamClosed = true; child.emit("close", 0, null); }); next();
    } });
    setImmediate(() => { frame("registered", { ...structuredClone(streamRegistration), binding: expected.binding, id: expected.id }); frame("progress", { state: "active" }); });
    const deadline = Date.now() + 1500, timer = setInterval(() => {
      if (p.h.saved().control.sealed.includes("bootstrap")) {
        clearInterval(timer); frame("terminal", { id: expected.id, nativeTerminal: true, campaign: "r21-0123456789abcdef", sealSha256: "f".repeat(64) });
      } else if (Date.now() > deadline) { clearInterval(timer); child.emit("close", 255, null); }
    }, 5);
    t.after(() => clearInterval(timer)); return child;
  };
  const approval = await p.approve("--detach"), factory = p.deps.providerFactory;
  p.deps.providerFactory = (options) => { const run = factory(options); run.close = async () => { assert.equal(streamClosed, true); providerClosed++; }; return run; };
  assert.equal(await productionMain(approval, p.deps), 3); assert.equal(started, 1); assert.equal(providerClosed, 2);
  assert.equal(p.h.saved().control.monitor.phase, "closed"); assert.deepEqual(p.h.saved().control.sealed, ["bootstrap"]);
  assert.ok(p.h.saved().control.ledger.every((row) => row.localTerminal)); assert.ok(!existsSync(join(p.h.local, "operation.lock")));
  const terminal = JSON.parse(readFileSync(join(p.h.local, "monitor-terminal.json"))); assert.equal(terminal.remoteDrained, false);
  assert.equal(p.h.deletes, 0);
});

test("production failed bootstrap seal settles its already-ready stream and retains custody", async (t) => {
  const p = productionHarness(t, { active: true, sealFail: true }), start = p.deps.streamSpawn;
  let child, closed = false;
  p.deps.streamSpawn = (...args) => { child = start(...args); child.once("close", () => { closed = true; }); return child; };
  try {
    await assert.rejects(productionMain(await p.approve("--detach"), p.deps), (error) => error.controlTreeUncertain === true);
    assert.equal(closed, true); assert.ok(existsSync(join(p.h.local, "monitor-invalid.json")));
    assert.ok(existsSync(join(p.h.local, "operation.lock"))); assert.ok(existsSync(join(p.h.base, ".groups-launch.lock")));
    assert.equal(p.h.deletes, 0);
  } finally {
    if (child && !closed) { const done = new Promise((resolve) => child.once("close", resolve)); child.stdin.destroy(); await done; }
  }
});

test("preview is local/read-only, missing isolated integration is explicit and cannot allocate", async (t) => {
  const p = productionHarness(t, { missingNative: true });
  assert.equal(await productionMain([...p.args("--detach"), "--print-approval"], p.deps), 2);
  assert.deepEqual(p.stdout[0].missing, nativePaths); assert.equal(p.stdout[0].fullGroupQualified, false);
  assert.ok(p.calls.every(([b, a]) => b === "git" && a[0] !== "fetch")); assert.ok(!existsSync(p.h.local));
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps), /integration missing/); assert.equal(p.h.creates, 0);
});

test("state aliases with resolved SSH expansion characters refuse preview and approved launch before provider access", async (t) => {
  for (const approved of [false, true]) {
    for (const nested of [false, true]) {
      const p = productionHarness(t);
      const values = p.args("--detach");
      if (nested) values[values.indexOf("--state-dir") + 1] = join(p.h.base, "new", "state");
      await productionMain([...values, "--print-approval"], p.deps);
      const args = approved ? [...values, "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256] : [...values, "--print-approval"];
      const target = `${p.h.base}$physical`;
      renameSync(p.h.base, target); symlinkSync(target, p.h.base, process.platform === "win32" ? "junction" : "dir");
      p.calls.length = 0; p.stdout.length = 0;
      await assert.rejects(productionMain(args, p.deps), /SSH config expansion/);
      assert.equal(p.h.creates, 0); assert.equal(p.h.deletes, 0);
      assert.deepEqual(p.calls, []); assert.deepEqual(p.stdout, []); assert.ok(!existsSync(p.h.local));
      if (nested) assert.ok(!existsSync(join(target, "new")));
    }
  }
});

test("ordinary state alias preserves preview and approved composed launch", async (t) => {
  const p = productionHarness(t, { active: true }), target = `${p.h.base} ordinary 'physical'`;
  renameSync(p.h.base, target); symlinkSync(target, p.h.base, process.platform === "win32" ? "junction" : "dir");
  const approval = await p.approve("--detach");
  assert.ok(!existsSync(p.h.local));
  assert.equal(await productionMain(approval, p.deps), 3);
  assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0); assert.equal(p.h.saved().status, "running");
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")).length, 1);
  assert.equal(await productionMain(await p.approve(), p.deps), 3);
  assert.equal(p.h.units, 2); assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
});

test("missing or inaccessible physical roots reject before child timeout and any process call", (t) => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"]) {
    const h = harness(t);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("cloud-path-fixture.mjs", import.meta.url)), code, h.temp],
      { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { code, calls: 0, bounded: true });
  }
});

test("nonexistent Windows drive rejects before child timeout", { skip: process.platform !== "win32" }, (t) => {
  const drive = [..."ZYXWVUTSRQPONMLKJIHGFED"].find((letter) => !existsSync(`${letter}:\\`));
  if (!drive) { t.skip("no missing local drive available"); return; }
  const h = harness(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("cloud-path-fixture.mjs", import.meta.url)), "windows", h.temp, `${drive}:\\state`],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { code: "windows", calls: 0, bounded: true });
});

test("normal new state directories preview without writes and create a bounded core root", async (t) => {
  const p = productionHarness(t), stateDir = join(p.h.base, "new", "state"), values = p.args("--detach");
  values[values.indexOf("--state-dir") + 1] = stateDir;
  assert.equal(await productionMain([...values, "--print-approval"], p.deps), 3);
  assert.ok(!existsSync(join(p.h.base, "new"))); assert.ok(p.calls.every(([b]) => b === "git"));
  const { controller } = await import("./droplet.mjs");
  controller({ round: "r21", stateDir, detach: true, commit, sshKey: "42", accountId, context }, { repo: p.h.repo, run() { assert.fail("unexpected process"); } });
  assert.ok(existsSync(stateDir)); assert.ok(!existsSync(join(stateDir, "groups-r21"))); assert.equal(p.h.creates, 0);
});

test("no/mismatched approval, dirty/mismatched source, unmerged head and fetch failure make no cloud calls", async (t) => {
  for (const flags of [{}, { dirty: true }, { wrongSource: true }, { unmerged: true }, { fetchError: true }]) {
    const p = productionHarness(t, flags);
    await assert.rejects(productionMain(p.args("--detach"), p.deps));
    if (!flags.dirty && !flags.wrongSource) {
      await assert.rejects(productionMain([...p.args("--detach"), "--approve-reviewed-merged-ready", "f".repeat(64)], p.deps));
      if (flags.unmerged || flags.fetchError) await assert.rejects(productionMain(await p.approve("--detach"), p.deps));
    }
    assert.ok(p.calls.every(([binary]) => binary === "git")); assert.ok(!existsSync(p.h.local));
  }
});

test("pre-reservation failures retain their closed controller stage without cloud calls", async (t) => {
  for (const [flags, stage] of [[{ fetchError: true }, "remote-main-fetch"], [{ unmerged: true }, "remote-main-ancestry"]]) {
    const p = productionHarness(t, flags), approval = await p.approve("--detach");
    await assert.rejects(productionMain(approval, p.deps), (error) => {
      assert.equal(error.controllerStage, stage); return true;
    });
    assert.ok(p.calls.every(([binary]) => binary === "git"));
    assert.ok(!existsSync(p.h.local)); assert.equal(p.h.creates, 0);
  }
});

test("frozen settlement failures retain their stronger uncertainty and stage", async (t) => {
  const p = productionHarness(t, { fetchError: true }), approval = await p.approve("--detach");
  const factory = p.deps.providerFactory;
  p.deps.providerFactory = (options) => {
    const provider = factory(options);
    provider.close = async () => { throw Object.freeze(Object.assign(new Error("PRIVATE_CLOSE"), {
      controlTreeUncertain: true, controlUncertain: true, providerDiagnostic: { code: "get-http", httpStatus: 503 },
    })); };
    return provider;
  };
  await assert.rejects(productionMain(approval, p.deps), (error) => {
    assert.equal(error.controllerStage, "provider-settlement");
    assert.equal(error.controlTreeUncertain, true); assert.equal(error.controlUncertain, true);
    assert.deepEqual(error.providerDiagnostic, { code: "get-http", httpStatus: 503 }); return true;
  });
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.creates, 0);
});

test("approved composed transport provisions fixed files and starts exactly once", async (t) => {
  const p = productionHarness(t, { active: true }), approval = await p.approve("--detach");
  assert.equal(await productionMain(approval, p.deps), 3); assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")).length, 1);
  assert.equal(p.calls.filter(([b, , o]) => b === "ssh" && o.input.includes("sha256sum --check")).length, 3);
  assert.equal(p.h.saved().fullGroupQualified, false);
  assert.ok(readFileSync(join(p.h.local, "job.sh"), "utf8").includes("git merge-base --is-ancestor"));
  await assert.rejects(productionMain(approval, p.deps), /reserved/); assert.equal(p.h.creates, 1);
});

test("production timed-out create retains uncertainty and both locks instead of treating an unsettled request as absent", async (t) => {
  const p = productionHarness(t, { createLost: true });
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps), (error) => error.controlUncertain === true);
  assert.equal(p.h.creates, 1); assert.equal(p.h.saved().status, "creating"); assert.equal(p.h.deletes, 0);
  assert.ok(existsSync(join(p.h.local, "operation.lock"))); assert.ok(existsSync(join(p.h.base, ".groups-launch.lock")));
  await assert.rejects(productionMain(await p.approve(), p.deps)); assert.equal(p.h.creates, 1);
});

test("failed upload verification never starts or deletes the owned host", async (t) => {
  const p = productionHarness(t, { uploadHashError: true });
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps));
  assert.equal(p.h.creates, 1); assert.equal(p.h.deletes, 0);
  assert.ok(!p.calls.some(([b, , o]) => b === "ssh" && o.input.includes("systemctl start")));
  assert.ok(existsSync(join(p.h.local, "job.sh"))); assert.equal(p.h.saved().status, "preparing");
});

test("approved running collect observes once; terminal blocked collect retains evidence before one delete", async (t) => {
  for (const active of [true, false]) {
    const p = productionHarness(t, { active }); p.h.seed();
    assert.equal(await productionMain(await p.approve(), p.deps), active ? 3 : 1);
    assert.equal(p.h.deletes, active ? 0 : 1); assert.equal(p.h.saved().fullGroupQualified, false);
    if (active) assert.equal(p.h.units, 1);
    else { assert.ok(p.h.saved().destroyedAt); assert.ok(existsSync(join(p.h.local, "results.tgz"))); }
  }
});

test("approval binds saved identity and detects state changes during merge verification", async (t) => {
  const flags = {}, p = productionHarness(t, flags); p.h.seed(); const approval = await p.approve();
  flags.afterFetch = () => p.h.change((s) => { s.token = "f".repeat(16); });
  await assert.rejects(productionMain(approval, p.deps)); assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.deletes, 0);
});

test("production deletion uncertainty is retained and a new approved collection never repeats delete", async (t) => {
  for (const flags of [{ deleteLost: true }, { deleteUnconfirmed: true }, { deleteRejected: true }]) {
    const p = productionHarness(t, flags); p.h.seed();
    await assert.rejects(productionMain(await p.approve(), p.deps));
    assert.equal(p.h.deletes, 1); assert.ok(p.h.saved().deletionIntentAt); assert.ok(!p.h.saved().destroyedAt);
    assert.ok(existsSync(join(p.h.local, "results.tgz")));
    if (flags.deleteRejected) assert.equal(await productionMain(await p.approve(), p.deps), 1);
    else await assert.rejects(productionMain(await p.approve(), p.deps), flags.deleteLost ? /EEXIST/ : /uncertain/);
    if (flags.deleteLost) assert.ok(existsSync(join(p.h.local, "operation.lock")));
    assert.equal(p.h.deletes, 1);
  }
});

test("production foreign identity and cancellation before provider access preserve resources", async (t) => {
  const p = productionHarness(t); p.h.seed(); p.h.hosts([]);
  await assert.rejects(productionMain(await p.approve(), p.deps)); assert.equal(p.h.deletes, 0);
  assert.ok(p.calls.every(([binary]) => !["ssh", "scp"].includes(binary)));
  const flags = {}, cancelled = productionHarness(t, flags); const approval = await cancelled.approve("--detach"); flags.cancelled = true;
  await assert.rejects(productionMain(approval, cancelled.deps)); assert.equal(cancelled.h.creates, 0); assert.ok(!existsSync(cancelled.h.local));
});

test("account changes cannot turn uncertain deletion into confirmed absence", async (t) => {
  const flags = { deleteUnconfirmed: true }, p = productionHarness(t, flags); p.h.seed();
  await assert.rejects(productionMain(await p.approve(), p.deps));
  assert.equal(p.h.deletes, 1); assert.ok(p.h.saved().deletionIntentAt);
  flags.accountId = "00000000-0000-4000-8000-000000000002"; p.h.hosts([]);
  await assert.rejects(productionMain(await p.approve(), p.deps), /account identity/);
  assert.ok(!p.h.saved().destroyedAt); assert.equal(p.h.deletes, 1);
});

test("account changes during the absence query also preserve deletion uncertainty", async (t) => {
  const flags = { deleteUnconfirmed: true }, p = productionHarness(t, flags); p.h.seed();
  await assert.rejects(productionMain(await p.approve(), p.deps));
  flags.hook = (binary, args) => {
    if (binary === "doctl" && args[2] === "get") { flags.accountId = "00000000-0000-4000-8000-000000000002"; p.h.hosts([]); }
  };
  await assert.rejects(productionMain(await p.approve(), p.deps), /account identity/);
  assert.ok(!p.h.saved().destroyedAt); assert.equal(p.h.deletes, 1);
});

test("approval binds account and context; legacy identity is never inferred", async (t) => {
  const p = productionHarness(t), approval = await p.approve("--detach");
  for (const [flag, value] of [["--account-id", "user:synthetic-other-user"], ["--context", "synthetic-other-context"]]) {
    const changed = [...approval]; changed[changed.indexOf(flag) + 1] = value;
    await assert.rejects(productionMain(changed, p.deps), /exact action/);
  }
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.creates, 0);
  p.h.seed(); p.h.change((s) => { delete s.provider; }); p.calls.length = 0;
  await assert.rejects(productionMain([...p.args(), "--print-approval"], p.deps), /saved provider identity/);
  assert.ok(p.calls.every(([binary]) => binary === "git"));
});

test("account mismatch prevents allocation and every provider call pins the saved context", async (t) => {
  const p = productionHarness(t, { accountId: "00000000-0000-4000-8000-000000000002" });
  await assert.rejects(productionMain(await p.approve("--detach"), p.deps), /account identity/);
  assert.equal(p.h.creates, 0); assert.equal(p.h.deletes, 0); assert.deepEqual(p.h.saved().provider, { accountId, context });
  for (const [, args] of p.calls.filter(([binary]) => binary === "doctl")) assert.equal(args[args.indexOf("--context") + 1], context);
});

test("team changes under the same user cannot confirm account-scoped absence", async (t) => {
  const flags = { deleteUnconfirmed: true, teamId: "synthetic-team-a" }, p = productionHarness(t, flags); p.h.seed();
  p.h.change((s) => { s.provider.accountId = "team:synthetic-team-a"; });
  await assert.rejects(productionMain(await p.approve(), p.deps), /deletion not confirmed/);
  flags.teamId = "synthetic-team-b"; p.h.hosts([]);
  await assert.rejects(productionMain(await p.approve(), p.deps), /account identity/);
  assert.ok(!p.h.saved().destroyedAt); assert.equal(p.h.deletes, 1);
});

test("missing or malformed provider identity is never absence authority", async (t) => {
  for (const response of [[], [{ uuid: "synthetic-a" }, { uuid: "synthetic-b" }], {}, { uuid: "synthetic-a", team: {} }, { uuid: "synthetic-a", team: null }]) {
    const p = productionHarness(t); p.h.seed(); const request = p.deps.providerRequest;
    p.deps.providerRequest = (options) => options.path === "/v2/account" ? { status: 200, value: { account: response } } : request(options);
    await assert.rejects(productionMain(await p.approve(), p.deps), /account identity/);
    assert.equal(p.h.deletes, 0); assert.ok(!p.h.saved().destroyedAt);
  }
});

test("retargeting an ordinary alias invalidates the approved physical root before allocation", async (t) => {
  const p = productionHarness(t), approval = await p.approve("--detach"), target = `${p.h.base}-moved`;
  renameSync(p.h.base, target); symlinkSync(p.h.repo, p.h.base, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(productionMain(approval, p.deps), /exact action/);
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.creates, 0);
});

test("production grammar permits authorization only, never arbitrary settings/adapters", () => {
  assert.equal(controllerPaths.length, 32);
  assert.ok(controllerPaths.includes("bench/workloads/cloud-cancellation.mjs"));
  assert.ok(controllerPaths.includes("bench/workloads/cloud-retirement.mjs"));
  assert.ok(controllerPaths.includes("bench/workloads/cloud-validation-snapshot.mjs"));
  for (const path of ["fleet.mjs", "fleet-verify.mjs", "fleet-worker.mjs", "cloud-control-stream.mjs", "isolated/control-stream-source.mjs"])
    assert.ok(controllerPaths.includes(`bench/workloads/${path}`));
  const args = ["r21", "--collect", "--state-dir", resolve("outside")];
  for (const suffix of [["--adapter", "evil"], ["--duration", "1"], ["--print-approval", "--print-approval"], ["--approve-reviewed-merged-ready", "not-a-hash"]])
    assert.throws(() => parseProductionArgs([...args, ...suffix]));
});

test("current saved-verifier checkout requirement fails before any provider access", async (t) => {
  const p = productionHarness(t); p.h.seed(); p.h.change((s) => { s.commit = "b".repeat(40); });
  await assert.rejects(productionMain([...p.args(), "--print-approval"], p.deps), /measured integrated checkout/);
  assert.ok(p.calls.every(([binary]) => binary === "git")); assert.equal(p.h.deletes, 0);
});

function groupProduction(t, flags = {}) {
  const p = productionHarness(t, flags), path = join(p.h.temp, "fleet.json");
  const fleet = fleetPlan({ round: "r21", commit, token: "f".repeat(16), sshKey: "42", provider: { accountId, context },
    tokens: Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")])) });
  writeFileSync(path, JSON.stringify(fleet));
  const values = [...p.args("--detach"), "--group", groupNames[0], "--fleet", path];
  return { p, path, fleet, values, async approval() {
    assert.equal(await productionMain([...values, "--print-approval"], p.deps), 3);
    return [...values, "--approve-reviewed-merged-ready", p.stdout.at(-1).approvalSha256];
  } };
}

test("group production approval binds complete fleet bytes before any provider access", async (t) => {
  for (const mutate of [(g) => g.fleet.jobs.pop(), (g) => g.fleet.provider.context = "other",
    (g) => g.fleet.selection.groups[0].apps.pop(), (g) => g.fleet.sshKey = "99",
    (g) => g.fleet.jobs.reverse(), () => {}]) {
    const g = groupProduction(t), args = await g.approval(); mutate(g);
    // Even semantically identical bytes have a new explicit approval identity.
    writeFileSync(g.path, `${JSON.stringify(g.fleet, null, 2)}\n`);
    await assert.rejects(productionMain(args, g.p.deps));
    assert.equal(g.p.h.creates, 0); assert.equal(g.p.h.deletes, 0);
    assert.ok(g.p.calls.every(([binary]) => binary === "git"));
  }
});

test("approved group composition runs only its native group and collection cannot relabel it", async (t) => {
  const g = groupProduction(t, { active: true });
  assert.equal(await productionMain(await g.approval(), g.p.deps), 3);
  assert.equal(g.p.h.creates, 1); assert.equal(g.p.h.deletes, 0);
  assert.equal(g.p.h.saved().group, groupNames[0]);
  assert.deepEqual(g.p.h.saved().selection.groups.map((row) => row.group), [groupNames[0]]);
  assert.ok(readFileSync(join(g.p.h.local, "job.sh"), "utf8").includes(`--group '${groupNames[0]}'`));
  const values = g.p.args();
  assert.equal(await productionMain([...values, "--print-approval"], g.p.deps), 3);
  assert.equal(await productionMain([...values, "--approve-reviewed-merged-ready", g.p.stdout.at(-1).approvalSha256], g.p.deps), 3);
  assert.equal(g.p.h.creates, 1); assert.equal(g.p.h.deletes, 0);
  await assert.rejects(productionMain([...values, "--group", groupNames[1], "--fleet", g.path, "--print-approval"], g.p.deps));
});

test("changing the fleet between preview and merged-source gate refuses allocation", async (t) => {
  const flags = {}, g = groupProduction(t, flags), args = await g.approval();
  flags.afterFetch = () => writeFileSync(g.path, `${JSON.stringify(g.fleet)}\n`);
  await assert.rejects(productionMain(args, g.p.deps));
  assert.equal(g.p.h.creates, 0); assert.ok(g.p.calls.every(([binary]) => binary === "git"));
});

test("fresh remote proof fetches only advertised objects without a shared reference or FETCH_HEAD write", async (t) => {
  const remoteHead = "b".repeat(40), p = productionHarness(t, { remoteHead, active: true });
  assert.equal(await productionMain(await p.approve("--detach"), p.deps), 3);
  const git = p.calls.filter(([binary]) => binary === "git").map(([, argv]) => argv);
  assert.deepEqual(git.filter((argv) => argv[0] === "ls-remote"),
    [["ls-remote", "--exit-code", "--refs", sourceUrl, "refs/heads/main"]]);
  assert.deepEqual(git.filter((argv) => argv[0] === "fetch"),
    [["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", sourceUrl, remoteHead]]);
  assert.ok(git.some((argv) => JSON.stringify(argv) === JSON.stringify(["merge-base", "--is-ancestor", commit, remoteHead])));
  assert.ok(!git.some((argv) => argv.some((arg) => arg.includes(":refs/") || arg === "FETCH_HEAD")));
});

test("missing, malformed or ambiguous remote main advertisements refuse before cloud access", async (t) => {
  for (const remoteLine of ["", `${commit}\trefs/heads/other\n`, `${commit}\trefs/heads/main\n${commit}\trefs/heads/main\n`,
    `${commit.slice(1)}\trefs/heads/main\n`, `${commit}\trefs/heads/main\nPRIVATE`]) {
    const p = productionHarness(t, { remoteLine });
    await assert.rejects(productionMain(await p.approve("--detach"), p.deps), /remote main advertisement/);
    assert.equal(p.h.creates, 0); assert.ok(p.calls.every(([binary]) => binary === "git"));
    assert.ok(!p.calls.some(([binary, argv]) => binary === "git" && argv[0] === "fetch"));
  }
});

test("locked launch rechecks the observed remote SHA rather than stale shared tracking refs", async (t) => {
  const remoteHead = "b".repeat(40), p = productionHarness(t, { remoteHead, staleTracking: true, active: true });
  assert.equal(await productionMain(await p.approve("--detach"), p.deps), 3);
  const ancestry = p.calls.filter(([binary, argv]) => binary === "git" && argv[0] === "merge-base");
  assert.equal(ancestry.length, 2);
  for (const [, argv] of ancestry) assert.deepEqual(argv, ["merge-base", "--is-ancestor", commit, remoteHead]);
  assert.equal(p.h.creates, 1); assert.equal(p.h.saved().status, "running");
});
