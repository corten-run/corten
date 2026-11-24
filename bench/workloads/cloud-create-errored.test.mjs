// Synthetic controls for issue #1689: a create the provider accepted and then
// failed. No provider, droplet or SSH process runs here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createProviderEngine as providerTransport } from "./cloud-engine-test-fixture.mjs";
import { context, harness, syntheticProviderRequest } from "./cloud-fixtures.mjs";
import { digest } from "./cloud-local.mjs";
import { createErroredBytes, createErroredRecord } from "./cloud-retirement.mjs";
import { publicError } from "./droplet.mjs";

const credential = "SYNTHETIC_ONLY_CREDENTIAL_A";
const spawn = () => ({ status: 0, stdout: Buffer.from(`${credential}\n`), stderr: Buffer.alloc(0) });
const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
  "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", "--context", context];
const posted = () => ({ status: 202, value: { droplet: { id: 3164444, status: "new", networks: { v4: [], v6: [] } },
  links: { actions: [{ id: 7515, rel: "create", href: "https://api.digitalocean.com/v2/actions/7515" }] } } });
const action = (fields = {}) => ({ status: 200, value: { action: { id: 7515, type: "create", resource_type: "droplet", resource_id: 3164444, status: "errored", ...fields } } });

// The provider first reports the new droplet pending, then errored: the r21 shape.
function engine(terminal = action(), { pending = 1 } = {}) {
  let clock = 0; const calls = [];
  const run = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; }, request({ method, path }) {
    calls.push({ method, path });
    if (method === "POST") return posted();
    return calls.length <= 1 + pending ? action({ status: "in-progress", resource_id: null }) : terminal;
  } });
  return { run, calls };
}

test("an errored create action bound to the POST droplet returns only its identity and a distinct code", async () => {
  const { run, calls } = engine();
  const result = await run(create, 5000, true);
  assert.equal(result.status, 1); assert.equal(result.stderr, "");
  assert.deepEqual(result.providerDiagnostic, { code: "create-action-errored" });
  assert.deepEqual(JSON.parse(result.stdout), [{ id: 3164444, actionId: 7515 }]);
  assert.ok(!JSON.stringify(result).includes(credential));
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "GET"]);
  assert.ok(calls.every(({ method, path }) => method !== "DELETE" && (method === "POST" || path === "/v2/actions/7515")));
  // Without permission to fail, the same observation is a stop, not a result.
  await assert.rejects(engine().run(create, 5000), (error) => error.providerDiagnostic?.code === "create-action-errored" && !error.controlUncertain);
});

test("an errored action without exact action/resource identity keeps the existing refusal", async () => {
  for (const fields of [{ resource_id: null }, { resource_id: 0 }, { resource_id: 3164445 }, { resource_id: "3164444" },
    { id: 7516 }, { type: "rebuild" }, { resource_type: "image" }, { status: "unknown" }, { status: "Errored" }]) {
    const { run, calls } = engine(action(fields));
    const result = await run(create, 5000, true);
    assert.deepEqual(result.providerDiagnostic, { code: "create-action-response" }, JSON.stringify(fields));
    assert.equal(result.stdout, "");
    assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
    assert.ok(!calls.some(({ method }) => method === "DELETE"));
  }
});

test("an errored action observed after the create deadline stays uncertain but names the posted IDs", async () => {
  // Pending until the original deadline: the r21 action errored 22 minutes later.
  const { run, calls } = engine(action(), { pending: 1000 });
  await assert.rejects(run(create, 2500, true), (error) => error.controlUncertain === true
    && error.providerDiagnostic?.code === "create-action-pending"
    && isDeepStrictEqual(error.pendingCreate, { dropletId: "3164444", actionId: "7515" }));
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
  // Before the POST returns its IDs, an unsettled create names nothing.
  let clock = 0;
  const lost = providerTransport({ repo: resolve("."), spawn, now: () => clock, sleep: async (ms) => { clock += ms; },
    request() { clock += 5000; throw new Error("synthetic lost response"); } });
  await assert.rejects(lost(create, 2500, true), (error) => error.controlUncertain === true && error.pendingCreate === undefined);
});

test("a later action read returns only the exact action's identity and status", async () => {
  const read = ["compute", "action", "get", "7515", "--output", "json", "--context", context];
  const reader = (value) => { const calls = [];
    return { calls, run: providerTransport({ repo: resolve("."), spawn, request({ method, path }) { calls.push({ method, path }); return value; } }) }; };
  const ok = reader(action({ region: { slug: "sfo3", raw: credential }, started_at: "x" }));
  const result = await ok.run(read);
  assert.deepEqual(JSON.parse(result.stdout), [{ id: 7515, type: "create", resource_type: "droplet", resource_id: 3164444, status: "errored" }]);
  assert.ok(!result.stdout.includes(credential));
  assert.deepEqual(ok.calls, [{ method: "GET", path: "/v2/actions/7515" }]);
  for (const fields of [{ id: 7516 }, { status: credential }, { resource_id: "3164444" }, { type: 7 }]) {
    const bad = reader(action(fields));
    await assert.rejects(bad.run(read, 60000, true), (error) => error.providerDiagnostic?.code === "action-response" && !error.controlUncertain);
  }
  const missing = reader({ status: 404, value: null });
  await assert.rejects(missing.run(read, 60000, true), (error) => error.providerDiagnostic?.code === "action-http");
  for (const argv of [["compute", "action", "get", "07515", "--output", "json"], ["compute", "action", "list", "7515", "--output", "json"]])
    await assert.rejects(reader(action()).run([...argv, "--context", context]));
});

const errored = (id = 123, actionId = 456) => ({ status: 1, stdout: JSON.stringify([{ id, actionId }]), stderr: "",
  providerDiagnostic: { code: "create-action-errored" } });
const providerCalls = (h) => h.calls.filter(([binary]) => binary === "doctl").map(([, ...args]) => args[0] === "account" ? "account" : args[2]);

// Wrap the synthetic controller transport. The fake create still checks that
// intent is durable before dispatch; the provider then fails it and holds hosts.
function erroredLaunch(t, { result = errored(), hosts = [], get, account, settle } = {}) {
  const h = harness(t); let created = false, accounts = 0;
  const run = (binary, args, ...rest) => {
    if (binary === "doctl" && args[2] === "create") {
      h.run(binary, args, ...rest); created = true; h.hosts(typeof hosts === "function" ? hosts(h) : hosts); return result;
    }
    if (binary === "doctl" && args[2] === "get" && get) { h.calls.push([binary, ...args]); return get(h, args); }
    if (binary === "doctl" && args[1] === "action") {
      h.calls.push([binary, ...args]);
      return { status: 0, stdout: JSON.stringify([{ id: 456, type: "create", resource_type: "droplet", resource_id: 123, status: "errored" }]), stderr: "" };
    }
    if (binary === "doctl" && args[0] === "account" && created && account) return account(h, ++accounts) ?? h.run(binary, args, ...rest);
    return h.run(binary, args, ...rest);
  };
  return { h, run, task: h.launch({ run, ...(settle ? { settle } : {}) }) };
}

test("provider-errored create with verified account and exact absence is a terminal outcome without DELETE or another create", async (t) => {
  const { h, task } = erroredLaunch(t);
  await assert.rejects(task.launch(), (error) => {
    assert.deepEqual(error.providerDiagnostic, { code: "create-errored-absent" });
    assert.ok(!error.controlUncertain && !error.controlTreeUncertain);
    assert.match(publicError(error), /verified absent/);
    assert.ok(!`${publicError(error)}${error.stack}`.includes(credential)); return true;
  });
  const state = h.saved();
  assert.equal(state.status, "creating"); assert.equal(state.id, undefined); assert.equal(state.deletionIntentAt, undefined);
  const path = join(h.local, "provider-create-errored.json"), bytes = readFileSync(path);
  assert.deepEqual(state.createErrored, { dropletId: "123", actionId: "456", evidenceSha256: digest(bytes) });
  const record = JSON.parse(bytes);
  assert.deepEqual(record.action, { id: 456, type: "create", resourceType: "droplet", resourceId: 123, status: "errored" });
  assert.deepEqual(record.account, { id: state.provider.accountId, verified: "before-and-after-each-provider-call" });
  assert.deepEqual(record.absence, { exactGet: { id: 123, httpStatus: 404 },
    inventory: { complete: true, droplets: 0, matchingId: 0, matchingName: 0, matchingTag: 0 } });
  assert.deepEqual(record.dispatched, { create: 1, replacementCreate: 0, delete: 0, guest: false });
  assert.equal(record.measurements, 0);
  assert.ok(!bytes.toString().includes(credential));
  // The saved account brackets the create and every provider read after it.
  const calls = providerCalls(h), at = calls.indexOf("create");
  assert.deepEqual(calls.slice(at - 1), ["account", "create", "account", "account", "get", "account", "account", "list", "account"]);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0); assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
  // The outer observers are retired: no lock remains and nothing is left to watch.
  assert.ok(!existsSync(join(h.local, "operation.lock"))); assert.ok(!existsSync(join(h.base, ".groups-launch.lock")));
  // Collection rechecks the receipt and absence, read-only, then reports terminal.
  const before = h.calls.length;
  assert.equal(await h.task().collect(), 1);
  assert.deepEqual(h.calls.slice(before).map(([, ...args]) => args[0] === "account" ? "account" : args[2]),
    ["account", "get", "account", "account", "list", "account"]);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
  // It never relaunches the same round, and a later attempt is separate evidence.
  await assert.rejects(h.launch().launch(), /already reserved/); assert.equal(h.creates, 1);
  const later = harness(t, { stateRoot: h.base, round: "r22", active: true });
  await later.launch().launch(); assert.equal(later.creates, 1);
  assert.deepEqual(h.saved(), state);
});

test("a changed receipt or reappearing allocation cannot be collected as terminal", async (t) => {
  const { h, task } = erroredLaunch(t);
  await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
  h.hosts([{ ...h.host(), id: 123 }]);
  await assert.rejects(h.task().collect(), /no longer verified absent/);
  h.hosts([]);
  const path = join(h.local, "provider-create-errored.json");
  const bytes = readFileSync(path, "utf8"); const { writeFileSync } = await import("node:fs");
  writeFileSync(path, bytes.replace('"measurements": 0', '"measurements": 1'));
  await assert.rejects(h.task().collect(), /receipt changed/);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
});

const foreign = (h) => ({ status: 0, stdout: JSON.stringify({ uuid: "synthetic-foreign-user", droplet_limit: 20 }), stderr: "" });
const negatives = {
  "exact GET still returns the allocation": { hosts: (h) => [h.host()] },
  "exact GET is not 404": { get: () => ({ status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 503 } }) },
  "exact GET transport fails": { get: () => { throw new Error("synthetic transport failure"); } },
  "inventory still lists the ID": { hosts: (h) => [h.host()], get: () => ({ status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 404 } }) },
  "inventory lists the name": { hosts: (h) => [{ ...h.host(), id: 999, tags: [] }] },
  "inventory lists the ownership tag": { hosts: (h) => [{ ...h.host(), id: 999, name: "corten-bench-groups-r21-ffffffffffffffff" }] },
  // The first post-create read passes; the read closing the exact GET does not.
  "account changes during the absence proof": { account: (h, count) => count >= 3 ? foreign(h) : undefined },
  "errored code without identity": { result: { ...errored(), stdout: "" } },
  "identity of a different allocation shape": { result: { ...errored(), stdout: '[{"id":123}]' } },
  "action not errored": { result: { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "create-action-response" } } },
};
for (const [name, options] of Object.entries(negatives)) {
  test(`provider-errored create stays preserved when ${name}`, async (t) => {
    const { h, task } = erroredLaunch(t, options);
    await assert.rejects(task.launch(), (error) => {
      assert.notEqual(error.providerDiagnostic?.code, "create-errored-absent");
      assert.doesNotMatch(publicError(error), /verified absent/); return true;
    });
    // A valid errored identity attempts the absence proof; anything else never reaches it.
    const calls = providerCalls(h), after = calls.slice(calls.indexOf("create") + 1);
    assert.equal(after.includes("get"), options.result === undefined, name);
    const state = h.saved();
    assert.equal(state.createErrored, undefined); assert.notEqual(state.status, "retired"); assert.equal(state.destroyedAt, undefined);
    assert.ok(!existsSync(join(h.local, "provider-create-errored.json")));
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
    assert.equal(providerCalls(h).filter((call) => call === "create").length, 1);
    assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
    await assert.rejects(h.launch().launch(), /already reserved/); assert.equal(h.creates, 1);
    // The unresolved reservation still blocks a later round in the same root.
    const later = harness(t, { stateRoot: h.base, round: "r22" });
    await assert.rejects(later.launch().launch(), /unresolved reservation blocks launch/); assert.equal(later.creates, 0);
  });
}

// The r21 shape: the create action was still pending at the launch's deadline and
// errored about 22 minutes later. Launch preserves custody with the posted IDs; a
// later collection reads that exact action and proves absence before resolving it.
const unsettled = (pendingCreate = { dropletId: "123", actionId: "456" }) => Object.assign(new Error("provider worker uncertain; preserve locks/state/evidence/host"),
  { controlUncertain: true, controlTreeUncertain: true, providerDiagnostic: { code: "create-action-pending" } }, pendingCreate ? { pendingCreate } : {});
const actionRow = (fields = {}) => ({ id: 456, type: "create", resource_type: "droplet", resource_id: 123, status: "errored", ...fields });
const deadPid = () => { const { pid } = spawnSync(process.execPath, ["-e", ""]); return pid; };
const lockPaths = (h) => [join(h.local, "operation.lock"), join(h.base, ".groups-launch.lock")];
function orphanLocks(h, pid = deadPid()) {
  const [operation, launch] = lockPaths(h);
  writeFileSync(operation, `${JSON.stringify({ ...JSON.parse(readFileSync(operation)), pid })}\n`);
  writeFileSync(launch, `${JSON.stringify({ ...JSON.parse(readFileSync(launch)), pid })}\n`);
}
const late = (h, args) => args[0] === "account" ? "account" : args[1] === "action" ? "action" : args[2];
function lateLaunch(t, { failure = unsettled(), hosts = [], flags = {} } = {}) {
  const h = harness(t, flags), o = { action: actionRow(), accounts: 0 };
  o.run = (binary, args, ...rest) => {
    if (binary === "doctl" && args[2] === "create") { h.run(binary, args, ...rest); h.hosts(hosts); throw failure; }
    if (binary === "doctl" && args[1] === "action") {
      h.calls.push([binary, ...args]); assert.deepEqual(args.slice(0, 6), ["compute", "action", "get", "456", "--output", "json"]);
      if (o.actionError) throw o.actionError;
      return { status: 0, stdout: JSON.stringify([o.action]), stderr: "" };
    }
    if (binary === "doctl" && args[2] === "get" && o.get) { h.calls.push([binary, ...args]); return o.get(args); }
    if (binary === "doctl" && args[0] === "account" && o.account) return o.account(++o.accounts) ?? h.run(binary, args, ...rest);
    return h.run(binary, args, ...rest);
  };
  o.collect = (deps = {}) => h.task({ run: o.run, ...deps }).collect();
  o.after = (before) => h.calls.slice(before).filter(([binary]) => binary === "doctl").map(([, ...args]) => late(h, args));
  return { h, o, task: h.launch({ run: o.run }) };
}
// The operator's custody step: the original controller, provider worker and their
// descendants are accounted for and gone; only then are the launch's locks released.
const release = (h) => { for (const path of lockPaths(h)) unlinkSync(path); };
function preserved(h, { identity = true, locks = false } = {}) {
  const state = h.saved();
  assert.equal(state.status, "creating"); assert.equal(state.id, undefined); assert.equal(state.createErrored, undefined);
  assert.deepEqual(state.createPending, identity ? { dropletId: "123", actionId: "456" } : undefined);
  assert.ok(!existsSync(join(h.local, "provider-create-errored.json")));
  assert.deepEqual(lockPaths(h).map((path) => existsSync(path)), [locks, locks], locks ? "the original launch locks stay" : "no lock is left");
  assert.ok(!existsSync(join(h.local, "create-recheck.lock")));
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
  assert.ok(!h.calls.some(([binary, ...args]) => binary === "ssh" || binary === "scp" || binary === "doctl" && args[2] === "delete"));
}

test("an action errored after the create deadline is resolved later from the saved IDs once the operator released the original custody", async (t) => {
  const { h, o, task } = lateLaunch(t);
  await assert.rejects(task.launch(), (error) => error.controlUncertain === true && error.providerDiagnostic?.code === "create-action-pending"
    && !/verified absent/.test(publicError(error)));
  preserved(h, { locks: true });
  // Neither the live launch (this test) nor a dead lock owner proves the original
  // process tree settled: no provider read is made and no lock is touched.
  for (const owner of ["live", "dead"]) {
    if (owner === "dead") orphanLocks(h);
    const before = h.calls.length;
    await assert.rejects(o.collect(), /original launch custody retained/, owner); assert.deepEqual(o.after(before), []); preserved(h, { locks: true });
  }
  release(h);
  // Still running at the later read: nothing changes.
  o.action = actionRow({ status: "in-progress", resource_id: null }); let before = h.calls.length;
  assert.equal(await o.collect(), 3); assert.deepEqual(o.after(before), ["account", "action", "account"]); preserved(h);
  o.action = actionRow(); before = h.calls.length;
  assert.equal(await o.collect(), 1);
  assert.deepEqual(o.after(before), ["account", "action", "account", "account", "get", "account", "account", "list", "account"]);
  const state = h.saved(), bytes = readFileSync(join(h.local, "provider-create-errored.json")), record = JSON.parse(bytes);
  assert.deepEqual(state.createErrored, { dropletId: "123", actionId: "456", evidenceSha256: digest(bytes) });
  assert.deepEqual(state.createPending, { dropletId: "123", actionId: "456" });
  assert.equal(state.status, "creating"); assert.equal(state.id, undefined); assert.equal(state.deletionIntentAt, undefined);
  assert.deepEqual(record, createErroredRecord(state, state.createErrored, 0, record.observedAt), "the same receipt as an in-deadline errored create");
  assert.ok([...lockPaths(h), join(h.local, "create-recheck.lock")].every((path) => !existsSync(path)));
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0); assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
  // Later collection is the existing read-only recheck; the round is never relaunched.
  before = h.calls.length;
  assert.equal(await o.collect(), 1); assert.deepEqual(o.after(before), ["account", "get", "account", "account", "list", "account"]);
  await assert.rejects(h.launch().launch(), /already reserved/);
  const next = harness(t, { stateRoot: h.base, round: "r22", active: true });
  await next.launch().launch(); assert.equal(next.creates, 1); assert.equal(h.creates, 1);
});

// Review round 2, finding 1. The previous controller released both locks here.
test("a dead lock owner whose descendant is still live keeps the original custody, with no provider read and no signal", async (t) => {
  const { h, o, task } = lateLaunch(t);
  await assert.rejects(task.launch(), { controlUncertain: true });
  // The recorded owner exits after starting a descendant that outlives it.
  const owner = spawnSync(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'],"
    + " { detached: true, stdio: 'ignore' }); c.unref(); process.stdout.write(String(c.pid));"], { encoding: "utf8" });
  const descendant = Number(owner.stdout);
  assert.ok(owner.status === 0 && Number.isSafeInteger(descendant) && descendant > 0);
  t.after(() => { try { process.kill(descendant); } catch { /* Already gone. */ } });
  orphanLocks(h, owner.pid);
  const locks = lockPaths(h).map((path) => readFileSync(path));
  o.action = actionRow(); // Errored, and the allocation is absent: only custody can stop it.
  const before = h.calls.length;
  await assert.rejects(o.collect(), /original launch custody retained/);
  assert.deepEqual(o.after(before), []);
  preserved(h, { locks: true });
  assert.ok(lockPaths(h).every((path, i) => readFileSync(path).equals(locks[i])), "the lock records are unchanged");
  assert.doesNotThrow(() => process.kill(descendant, 0), "the descendant was not signalled");
});

test("a pending create whose locks an operator already released resolves under the ordinary operation lock", async (t) => {
  const { h, o, task } = lateLaunch(t);
  await assert.rejects(task.launch(), { controlUncertain: true });
  release(h);
  assert.equal(await o.collect(), 1);
  assert.ok(h.saved().createErrored); assert.ok(!existsSync(join(h.local, "operation.lock")));
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
});

const foreignAccount = () => ({ status: 0, stdout: JSON.stringify({ uuid: "synthetic-foreign-user", droplet_limit: 20 }), stderr: "" });
const lateNegatives = {
  "the action is bound to another droplet": (h, o) => { o.action = actionRow({ resource_id: 124 }); },
  "the errored action is unbound": (h, o) => { o.action = actionRow({ resource_id: null }); },
  "the action is another action": (h, o) => { o.action = actionRow({ id: 457 }); },
  "the action is not a create": (h, o) => { o.action = actionRow({ type: "rebuild" }); },
  "the action read fails": (h, o) => { o.actionError = new Error("synthetic action read failure"); },
  "the exact GET still returns the allocation": (h) => { h.hosts([h.host()]); },
  "the exact GET is not 404": (h, o) => { o.get = () => ({ status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 503 } }); },
  "the inventory lists the name": (h) => { h.hosts([{ ...h.host(), id: 999, tags: [] }]); },
  "the inventory lists the ownership tag": (h) => { h.hosts([{ ...h.host(), id: 999, name: "corten-bench-groups-r21-ffffffffffffffff" }]); },
  "the account changes during the proof": (h, o) => { o.account = (count) => count >= 3 ? foreignAccount() : undefined; },
};
for (const [name, change] of Object.entries(lateNegatives)) {
  test(`a pending create stays preserved when ${name}`, async (t) => {
    const { h, o, task } = lateLaunch(t);
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h); change(h, o);
    await assert.rejects(o.collect(), (error) => !error.controlUncertain && !/verified absent/.test(publicError(error)));
    preserved(h);
    await assert.rejects(h.launch().launch(), /already reserved/);
    const next = harness(t, { stateRoot: h.base, round: "r22" });
    await assert.rejects(next.launch().launch(), /unresolved reservation/); assert.equal(next.creates, 0);
  });
}

test("a pending create stays preserved with partial custody, after an uncertain read, and without posted IDs", async (t) => {
  for (const kept of [0, 1]) {
    const partial = lateLaunch(t);
    await assert.rejects(partial.task.launch(), { controlUncertain: true });
    unlinkSync(lockPaths(partial.h)[1 - kept]);
    await assert.rejects(partial.o.collect(), /partial launch custody/);
    assert.ok(!partial.h.calls.some(([, ...args]) => args[1] === "action"));
  }
  // An uncertain read keeps this collect's own operation lock: a stopped collect
  // leaves the same shape, and the next collect refuses it before any provider read.
  const uncertain = lateLaunch(t);
  await assert.rejects(uncertain.task.launch(), { controlUncertain: true });
  release(uncertain.h); uncertain.o.actionError = unsettled(undefined);
  await assert.rejects(uncertain.o.collect(), { controlUncertain: true });
  assert.deepEqual(lockPaths(uncertain.h).map((path) => existsSync(path)), [true, false]);
  uncertain.o.actionError = undefined;
  const before = uncertain.h.calls.length;
  await assert.rejects(uncertain.o.collect(), /partial launch custody/); assert.deepEqual(uncertain.o.after(before), []);
  unlinkSync(lockPaths(uncertain.h)[0]); preserved(uncertain.h);
  const anonymous = lateLaunch(t, { failure: unsettled(null) });
  await assert.rejects(anonymous.task.launch(), { controlUncertain: true });
  release(anonymous.h);
  await assert.rejects(anonymous.o.collect());
  preserved(anonymous.h, { identity: false });
  assert.ok(!anonymous.h.calls.some(([, ...args]) => args[1] === "action"));
});

// Review round 1. Each control below failed against the previous controller.
const page = (droplets, extra = {}) => ({ status: 200, value: { droplets, meta: { total: droplets.length }, links: {}, ...extra } });
const otherRow = (id, fields = {}) => ({ id, name: `other-${id}`, tags: ["other"], region: { raw: credential }, ...fields });
const nextPage = { pages: { next: "https://api.digitalocean.com/v2/droplets?page=2&per_page=200" } };

test("the absence census is one provider response whose every row has an inspectable ID, name and tags", async () => {
  const args = ["compute", "droplet", "list", "--single-response", "--output", "json", "--context", context];
  const reader = (...pages) => { const calls = [];
    return { calls, run: providerTransport({ repo: resolve("."), spawn, request({ method, path }) {
      calls.push({ method, path }); return pages[Math.min(calls.length - 1, pages.length - 1)]; } }) }; };
  const ok = reader(page([otherRow(1), otherRow(2)]));
  assert.deepEqual(JSON.parse((await ok.run(args)).stdout), [{ id: 1, name: "other-1", tags: ["other"] }, { id: 2, name: "other-2", tags: ["other"] }]);
  assert.deepEqual(ok.calls, [{ method: "GET", path: "/v2/droplets?page=1&per_page=200" }]);
  for (const [response, code] of [
    [page([otherRow(999, { name: null, tags: null })]), "list-response-shape"],
    [page([otherRow(999, { tags: [7] })]), "list-response-shape"],
    [page([otherRow(999, { name: "" })]), "list-response-shape"],
    [page([otherRow(999)], { meta: { total: 2 } }), "list-response-count"],
    [page([otherRow(1)], { meta: { total: 201 } }), "list-response-bounds"],
    [page([otherRow(1)], { meta: { total: 2 }, links: nextPage }), "list-response-bounds"],
    [page([otherRow(1), otherRow(1)]), "list-response-duplicate"],
  ]) {
    // A second, clean response is available; the census must never take it.
    const bad = reader(response, page([]));
    await assert.rejects(bad.run(args), (error) => error.providerDiagnostic?.code === code && !error.controlUncertain, code);
    assert.equal(bad.calls.length, 1, `${code}: never retaken`);
  }
});

test("the late recheck through the provider engine refuses a malformed row or a match it cannot keep, and accepts one clean response", async (t) => {
  for (const kind of ["malformed", "matched-then-count-changed", "clean"]) {
    const { h, task } = lateLaunch(t);
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h);
    const name = h.saved().name, lists = [], base = syntheticProviderRequest(h);
    const response = { malformed: page([{ id: 999, name: null, tags: null }]),
      "matched-then-count-changed": page([otherRow(999, { name })], { meta: { total: 2 }, links: nextPage }), clean: page([otherRow(999)]) }[kind];
    const engineRun = providerTransport({ repo: resolve("."), spawn, async request(input) {
      if (input.path === "/v2/actions/456") return { status: 200, value: { action: actionRow() } };
      if (input.path.startsWith("/v2/droplets?")) { lists.push(input.path); return lists.length === 1 ? response : page([]); }
      return base(input);
    } });
    // As across the worker IPC boundary, a permitted refusal carries no native error object.
    const run = async (binary, args, timeout, allowFail, ...rest) => {
      if (binary !== "doctl") return h.run(binary, args, timeout, allowFail, ...rest);
      const { error, ...result } = await engineRun(args, timeout, allowFail); return result;
    };
    if (kind === "clean") {
      assert.equal(await h.task({ run }).collect(), 1);
      assert.equal(JSON.parse(readFileSync(join(h.local, "provider-create-errored.json"))).absence.inventory.droplets, 1);
    } else {
      await assert.rejects(h.task({ run }).collect(), (error) => !error.controlUncertain && error.providerDiagnostic?.code
        === (kind === "malformed" ? "list-response-shape" : "list-response-bounds"));
      preserved(h);
    }
    assert.deepEqual(lists, ["/v2/droplets?page=1&per_page=200"], kind);
  }
});

test("a teardown that fails after the create failure is recorded keeps the operation lock, and every later path refuses", async (t) => {
  for (const mode of ["rejected", "withheld"]) {
    const { h, o, task } = lateLaunch(t);
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h);
    const operation = lockPaths(h)[0];
    let fail, entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    const settle = mode === "rejected" ? async () => { throw new Error("synthetic teardown failure"); }
      : () => { entered(); return new Promise((_, reject) => { fail = reject; }); };
    const pending = o.collect({ settle });
    if (mode === "withheld") {
      await reached;
      assert.ok(h.saved().createErrored); assert.ok(existsSync(operation), "withheld: the lock stays");
      fail(new Error("synthetic teardown failure"));
    }
    await assert.rejects(pending, (error) => error.controlTreeUncertain === true && /teardown uncertain/.test(error.message));
    assert.ok(h.saved().createErrored); assert.ok(existsSync(operation), `${mode}: the lock stays`);
    const before = h.calls.length;
    await assert.rejects(o.collect(), /still holds custody/); assert.equal(h.calls.length, before, "no provider read");
    await assert.rejects(h.launch().launch(), /already reserved/);
    const next = harness(t, { stateRoot: h.base, round: "r22" });
    await assert.rejects(next.launch().launch(), /unresolved reservation/); assert.equal(next.creates, 0);
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
  }
});

test("any lock left beside a recorded create failure keeps it unresolved for collect and a later round", async (t) => {
  for (const name of ["create-recheck.lock", "operation.lock", "launch"]) {
    const { h, o, task } = lateLaunch(t);
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h); assert.equal(await o.collect(), 1);
    const path = name === "launch" ? lockPaths(h)[1] : join(h.local, name);
    writeFileSync(path, "SYNTHETIC");
    const before = h.calls.length;
    await assert.rejects(o.collect(), /still holds custody/);
    assert.equal(h.calls.length, before);
    const next = harness(t, { stateRoot: h.base, round: "r22", active: true });
    await assert.rejects(next.launch().launch(), name === "launch" ? /EEXIST/ : /unresolved reservation blocks launch/); assert.equal(next.creates, 0);
  }
});

test("an in-deadline errored create whose teardown failed keeps both locks until the custody step, then only rechecks", async (t) => {
  const { h, run, task } = erroredLaunch(t, { settle: async () => { throw new Error("synthetic teardown failure"); } });
  await assert.rejects(task.launch(), { controlTreeUncertain: true });
  const state = h.saved();
  assert.deepEqual(state.createPending, { dropletId: "123", actionId: "456" }); assert.ok(state.createErrored);
  assert.ok(lockPaths(h).every((path) => existsSync(path)));
  for (const owner of ["live", "dead"]) {
    if (owner === "dead") orphanLocks(h);
    const before = h.calls.length;
    await assert.rejects(h.task({ run }).collect(), /still holds custody/, owner); assert.equal(h.calls.length, before);
  }
  release(h);
  const before = h.calls.length;
  assert.equal(await h.task({ run }).collect(), 1);
  assert.deepEqual(h.calls.slice(before).map(([, ...args]) => args[0] === "account" ? "account" : args[2]),
    ["account", "get", "account", "account", "list", "account"]);
  assert.ok([...lockPaths(h), join(h.local, "create-recheck.lock")].every((path) => !existsSync(path)));
  assert.deepEqual(h.saved(), state); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
});

test("a receipt left before its state publication is adopted only after a fresh proof and only with canonical bytes", async (t) => {
  for (const kind of ["canonical", "changed", "allocation-present"]) {
    const { h, o, task } = lateLaunch(t);
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h);
    const state = h.saved(), canonical = createErroredBytes(createErroredRecord(state, state.createPending, 2, "2026-11-20T00:00:00.000Z"));
    const bytes = kind === "changed" ? canonical.replace('"measurements": 0', '"measurements": 1') : canonical;
    const path = join(h.local, "provider-create-errored.json"); writeFileSync(path, bytes);
    if (kind === "allocation-present") h.hosts([h.host()]);
    const before = h.calls.length;
    if (kind === "canonical") {
      assert.equal(await o.collect(), 1);
      assert.deepEqual(o.after(before), ["account", "action", "account", "account", "get", "account", "account", "list", "account"]);
      assert.equal(h.saved().createErrored.evidenceSha256, digest(canonical));
    } else {
      await assert.rejects(o.collect(), kind === "changed" ? /unpublished create failure receipt differs/ : /not verified absent/);
      assert.equal(h.saved().createErrored, undefined);
    }
    assert.ok(lockPaths(h).every((lock) => !existsSync(lock)));
    assert.equal(readFileSync(path, "utf8"), bytes, "the receipt is never rewritten");
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
  }
});

// Review round 2, finding 5. The previous controller stopped with EEXIST on the staging file.
test("a stopped state write's staging file does not prevent adopting the receipt, and is never read or removed", async (t) => {
  const { h, o, task } = lateLaunch(t);
  await assert.rejects(task.launch(), { controlUncertain: true });
  release(h);
  // A process stopped after writing the receipt and its fixed-name staging state, before the rename.
  const state = h.saved(), canonical = createErroredBytes(createErroredRecord(state, state.createPending, 0, "2026-11-20T00:00:00.000Z"));
  writeFileSync(join(h.local, "provider-create-errored.json"), canonical);
  const staging = join(h.local, "state.json.tmp"), staged = `${JSON.stringify({ ...state,
    createErrored: { ...state.createPending, evidenceSha256: digest(canonical) } }, null, 2)}\n`;
  writeFileSync(staging, staged);
  const before = h.calls.length;
  assert.equal(await o.collect(), 1);
  assert.deepEqual(o.after(before), ["account", "action", "account", "account", "get", "account", "account", "list", "account"]);
  assert.deepEqual(h.saved().createErrored, { ...state.createPending, evidenceSha256: digest(canonical) });
  assert.equal(readFileSync(staging, "utf8"), staged, "the staging file is left exactly as found");
  assert.ok(lockPaths(h).every((lock) => !existsSync(lock)));
  assert.equal(await o.collect(), 1); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
});

test("a collect stopped while holding its operation lock is refused before any provider read until the custody step", async (t) => {
  const { h, o, task } = lateLaunch(t);
  await assert.rejects(task.launch(), { controlUncertain: true });
  release(h);
  writeFileSync(lockPaths(h)[0], `${JSON.stringify({ pid: deadPid(), at: new Date().toISOString() })}\n`);
  const before = h.calls.length;
  await assert.rejects(o.collect(), /partial launch custody/); assert.deepEqual(o.after(before), []);
  unlinkSync(lockPaths(h)[0]); // The custody step for that collect's lock.
  assert.equal(await o.collect(), 1); assert.ok(h.saved().createErrored);
});

// Review round 2, finding 3. The previous controller bound droplet 999 and saved no IDs
// before the absence proof.
test("an in-deadline errored create saves its posted IDs before absence and never binds another allocation", async (t) => {
  // The exact ID is 404, but the census lists another droplet with this create's name and tags.
  const other = erroredLaunch(t, { hosts: (h) => [{ ...h.host(), id: 999 }] });
  await assert.rejects(other.task.launch(), /differs from the posted create/);
  let state = other.h.saved();
  assert.equal(state.status, "creating"); assert.equal(state.id, undefined); assert.equal(state.createErrored, undefined);
  assert.deepEqual(state.createPending, { dropletId: "123", actionId: "456" });
  await assert.rejects(other.h.task({ run: other.run }).collect(), /not verified absent/);
  assert.deepEqual(other.h.saved(), state, "the contradiction stays unresolved");
  assert.equal(other.h.creates, 1); assert.equal(other.h.deletes, 0);
  // The exact allocation is present under another name, so absence fails and nothing is bound.
  const renamed = erroredLaunch(t, { hosts: (h) => [{ ...h.host(), name: "corten-bench-groups-r21-renamed" }] });
  await assert.rejects(renamed.task.launch(), /owned droplet missing or ambiguous/);
  state = renamed.h.saved();
  assert.equal(state.id, undefined); assert.deepEqual(state.createPending, { dropletId: "123", actionId: "456" });
  // Once it has gone, a later collect rechecks that exact action and settles it.
  renamed.h.hosts([]);
  assert.equal(await renamed.h.task({ run: renamed.run }).collect(), 1);
  assert.ok(renamed.h.saved().createErrored); assert.equal(renamed.h.creates, 1); assert.equal(renamed.h.deletes, 0);
});

test("a completed create of its exact allocation is bound, and a fresh pinned collection retires it", async (t) => {
  const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
  await assert.rejects(task.launch(), { controlUncertain: true });
  o.action = actionRow({ status: "completed" }); h.hosts([h.host()]);
  // With the original locks still present the same completed action is refused before any read.
  await assert.rejects(o.collect(), /original launch custody retained/);
  release(h);
  const before = h.calls.length;
  assert.equal(await o.collect(), 3);
  assert.deepEqual(o.after(before), ["account", "action", "account", "account", "list", "account"]);
  const state = h.saved();
  assert.equal(state.status, "preparing"); assert.equal(state.id, "123"); assert.equal(state.ip, "192.0.2.10");
  assert.deepEqual(state.createPending, { dropletId: "123", actionId: "456" }); assert.equal(state.createErrored, undefined);
  assert.ok(!existsSync(join(h.local, "operation.lock")));
  // Bound only: no SSH, upload, unit start or DELETE.
  assert.ok(!h.calls.some(([binary, ...args]) => binary === "ssh" || binary === "scp" || binary === "doctl" && args[2] === "delete"));
  // A monitored reservation then needs the pinned unused-bootstrap approval.
  await assert.rejects(o.collect(), /approved pinned observation/);
  assert.equal(await h.pinnedUnused({ run: o.run }).collect(), 1);
  const retired = h.saved();
  assert.equal(retired.retirement.kind, "unused"); assert.ok(retired.destroyedAt); assert.equal(h.deletes, 1); assert.equal(h.creates, 1);
});

// Review round 2, finding 4. Each collection owns one provider; after close every call
// fails as uncertain, as production's close contract does. The previous controller
// reused the closed provider and kept a new operation lock without a DELETE.
test("an unmonitored completed allocation is bound by one collection and retired by a fresh one with its own provider", async (t) => {
  const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
  await assert.rejects(task.launch(), { controlUncertain: true });
  release(h);
  h.change((s) => { delete s.control.monitor; });
  o.action = actionRow({ status: "completed" }); h.hosts([h.host()]);
  const providers = [];
  const collect = () => {
    const provider = { closed: 0 }; providers.push(provider);
    const run = (binary, args, ...rest) => {
      if (binary === "doctl" && provider.closed) throw Object.assign(new Error("synthetic closed provider"), { controlUncertain: true });
      return o.run(binary, args, ...rest);
    };
    return h.task({ run, settle: async () => { provider.closed++; } }).collect();
  };
  assert.equal(await collect(), 3);
  const bound = h.saved();
  assert.equal(bound.status, "preparing"); assert.equal(bound.id, "123"); assert.equal(bound.control.monitor, undefined);
  assert.ok(!existsSync(join(h.local, "operation.lock"))); assert.equal(h.deletes, 0);
  assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
  assert.equal(await collect(), 1);
  const retired = h.saved();
  assert.equal(retired.retirement.kind, "unused"); assert.ok(retired.destroyedAt);
  assert.equal(h.deletes, 1); assert.equal(h.creates, 1);
  assert.ok(!existsSync(join(h.local, "operation.lock")));
  assert.deepEqual(providers.map(({ closed }) => closed), [1, 1], "each collection closed its own provider once");
});
