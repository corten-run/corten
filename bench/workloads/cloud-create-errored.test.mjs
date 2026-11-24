// Synthetic controls for issue #1689: a create the provider accepted and then
// failed. No provider, droplet or SSH process runs here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createProviderEngine as providerTransport } from "./cloud-engine-test-fixture.mjs";
import { context, harness, syntheticProviderRequest } from "./cloud-fixtures.mjs";
import { digest, durable } from "./cloud-local.mjs";
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
function erroredLaunch(t, { result = errored(), hosts = [], get, account, settle, flags = {} } = {}) {
  const h = harness(t, flags); let created = false, accounts = 0;
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

test("a changed receipt cannot be collected as terminal", async (t) => {
  const { h, task } = erroredLaunch(t);
  await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
  const path = join(h.local, "provider-create-errored.json");
  const bytes = readFileSync(path, "utf8"); const { writeFileSync } = await import("node:fs");
  writeFileSync(path, bytes.replace('"measurements": 0', '"measurements": 1'));
  await assert.rejects(h.task().collect(), /receipt changed/);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
});

// Review round 3, finding 1. The previous controller refused this collect but kept the
// receipt acceptable, so the reservation resolved again once the droplet was not seen.
test("a recorded failure whose posted droplet is seen again is contradicted for good, by exact GET or census", async (t) => {
  const seen = {
    // The exact GET returns the posted ID, renamed and untagged.
    "exact-get": (h) => [{ ...h.host(), name: "renamed-by-someone", tags: [] }],
    // The exact GET is 404, but the census lists a droplet with this create's run tag.
    inventory: (h) => [{ ...h.host(), id: 999, name: "other" }],
  };
  for (const [via, hosts] of Object.entries(seen)) {
    const { h, task } = erroredLaunch(t);
    await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
    const receipt = readFileSync(join(h.local, "provider-create-errored.json")), before = h.saved();
    h.hosts(hosts(h));
    await assert.rejects(h.task().collect(), /observed again/, via);
    const after = h.saved();
    assert.deepEqual(after.createErrored, { ...before.createErrored, reappeared: { at: after.createErrored.reappeared.at, via,
      dropletId: via === "exact-get" ? "123" : "999" } });
    assert.equal(after.status, "creating"); assert.equal(after.id, undefined);
    assert.ok(readFileSync(join(h.local, "provider-create-errored.json")).equals(receipt), "the receipt is kept as evidence");
    assert.ok(!existsSync(join(h.local, "operation.lock")), "the refusal is recorded state, not retained custody");
    // Gone again: the record still refuses after only the exact GET of the posted ID (the
    // contradicted route of review round 4, finding 3; never a census), and blocks a later round.
    h.hosts([]);
    const calls = h.calls.length;
    await assert.rejects(h.task().collect(), /observed again/);
    assert.deepEqual(h.calls.slice(calls).map(([, ...args]) => args[0] === "account" ? "account" : args[2]), ["account", "get", "account"]);
    assert.equal(h.saved().id, undefined);
    const next = harness(t, { stateRoot: h.base, round: "r22" });
    await assert.rejects(next.launch().launch(), /observed again/); assert.equal(next.creates, 0);
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
    assert.ok(!h.calls.some(([binary, ...args]) => binary === "ssh" || binary === "scp" || binary === "doctl" && args[2] === "delete"));
  }
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
  // Review round 3, finding 2: the exact posted droplet binds only when positively owned.
  "the exact GET returns the posted ID under another name": (h) => { h.hosts([{ ...h.host(), name: "corten-bench-groups-r21-renamed" }]); },
  "the exact GET returns the posted ID without its run tag": (h) => { h.hosts([{ ...h.host(), tags: ["corten-bench", "corten-bench-groups"] }]); },
  "the exact GET returns the posted ID in another region": (h) => { h.hosts([{ ...h.host(), region: { slug: "nyc1" } }]); },
  "the exact GET returns the posted ID with no public address": (h) => { h.hosts([{ ...h.host(), networks: { v4: [] } }]); },
  "the exact GET is 404 but the census lists the posted ID": (h, o) => { h.hosts([h.host()]);
    o.get = () => ({ status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 404 } }); },
  "the exact GET returns another ID": (h, o) => { o.get = () => ({ status: 0, stdout: JSON.stringify([{ ...h.host(), id: 999 }]), stderr: "" }); },
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
    } else if (kind === "changed") {
      await assert.rejects(o.collect(), /unpublished create failure receipt differs/);
      assert.equal(h.saved().createErrored, undefined);
    } else {
      // The exact owned posted droplet contradicts the receipt: bound, never adopted (review round 4, finding 3).
      assert.equal(await o.collect(), 3);
      const saved = h.saved();
      assert.equal(saved.createErrored, undefined); assert.equal(saved.id, "123"); assert.equal(saved.createContradicted.evidenceSha256, digest(bytes));
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
  // Review round 6, finding 1: a census row binds nothing, so this refuses before any bind.
  await assert.rejects(other.task.launch(), /not the exact posted droplet; preserve reservation without binding/);
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
  // Review round 6, finding 1: the bind's only read is the exact GET of the posted ID, never a census.
  assert.deepEqual(o.after(before), ["account", "action", "account", "account", "get", "account"]);
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

// Review round 3, finding 2. The previous controller refused every collect here, before
// binding, so the existing allocation could never reach unused retirement.
test("a late errored action whose exact posted droplet is still present and owned is bound alone, then retired as unused", async (t) => {
  const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
  await assert.rejects(task.launch(), { controlUncertain: true });
  release(h);
  h.hosts([h.host()]); // The errored action's droplet still exists under its saved name, tags and placement.
  const before = h.calls.length;
  assert.equal(await o.collect(), 3);
  assert.deepEqual(o.after(before), ["account", "action", "account", "account", "get", "account"], "no census and no further read after the exact GET");
  const state = h.saved();
  assert.equal(state.status, "preparing"); assert.equal(state.id, "123"); assert.equal(state.ip, "192.0.2.10");
  assert.deepEqual(state.createPending, { dropletId: "123", actionId: "456" }); assert.equal(state.createErrored, undefined);
  assert.ok(!existsSync(join(h.local, "provider-create-errored.json")));
  assert.ok(!existsSync(join(h.local, "operation.lock"))); assert.equal(h.deletes, 0);
  assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
  // The existing fresh unused-retirement proofs then apply, as for an in-deadline bind.
  await assert.rejects(o.collect(), /approved pinned observation/); assert.equal(h.deletes, 0);
  assert.equal(await h.pinnedUnused({ run: o.run }).collect(), 1);
  const retired = h.saved();
  assert.equal(retired.retirement.kind, "unused"); assert.ok(retired.destroyedAt); assert.equal(h.deletes, 1); assert.equal(h.creates, 1);
});

// Review round 2, finding 4. Each collection owns one provider; after close every call
// fails as uncertain, as production's close contract does. The previous controller
// reused the closed provider and kept a new operation lock without a DELETE. This
// synthetic reservation has its monitor removed only to reach the ordinary unused path
// without the pinned approval; no launch writes that shape. A real unmonitored
// reservation is an offline handoff, covered in fleet-production.test.mjs.
test("the bind of a completed allocation is its own checkpoint, and the next collection retires it with its own provider", async (t) => {
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

// Review round 4, finding 1. The previous launch fenced only names and tags in a root with
// an earlier provider-errored round: it saved create intent and sent a create while its
// census still listed that round's posted droplet 123 under another name.
test("a later launch in the same root sends no create while its census lists an earlier provider-errored create's posted ID", async (t) => {
  for (const row of [{ name: "renamed-by-someone", tags: [] }, { name: "other", tags: ["unrelated"], region: { slug: "nyc1" } }]) {
    const { h, task } = erroredLaunch(t);
    await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
    const next = harness(t, { stateRoot: h.base, round: "r22", hostId: "999", createReturnedId: 999, active: true });
    next.hosts([{ ...h.host(), ...row }]);
    await assert.rejects(next.launch().launch(), /posted droplet is listed/);
    assert.equal(next.creates, 0); assert.ok(!providerCalls(next).includes("create"));
    const saved = next.saved();
    assert.equal(saved.createIntentAt, undefined); assert.notEqual(saved.status, "creating");
  }
  // A failure recorded on another provider account cannot be fenced by this census.
  const { h, task } = erroredLaunch(t);
  await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
  const receipt = join(h.local, "provider-create-errored.json"), observedAt = JSON.parse(readFileSync(receipt)).observedAt;
  h.change((s) => {
    s.provider.accountId = "user:synthetic-other-account";
    const bytes = createErroredBytes(createErroredRecord(s, s.createErrored, 0, observedAt));
    writeFileSync(receipt, bytes); s.createErrored.evidenceSha256 = digest(bytes);
  });
  const foreignRoot = harness(t, { stateRoot: h.base, round: "r22", hostId: "999", createReturnedId: 999, active: true });
  await assert.rejects(foreignRoot.launch().launch(), /another provider account/); assert.equal(foreignRoot.creates, 0);
  // With the ID absent the same root launches.
  const clean = erroredLaunch(t);
  await assert.rejects(clean.task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
  const later = harness(t, { stateRoot: clean.h.base, round: "r22", hostId: "999", createReturnedId: 999, active: true });
  later.hosts([{ ...clean.h.host(), id: 555, name: "unrelated", tags: [] }]);
  await later.launch().launch(); assert.equal(later.creates, 1);
});

// Review round 4, finding 2. A contradiction whose state publication did not complete.
const eio = () => Object.assign(new Error("synthetic EIO"), { code: "EIO" });
const reappearedStage = (h) => readdirSync(h.local).filter((name) => /^state\.json\.create-reappeared-[a-f0-9]{32}\.tmp$/.test(name));
test("a stage left by an interrupted contradiction publication keeps the receipt from resolving", async (t) => {
  const { h, run, task } = erroredLaunch(t);
  await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
  // The previous controller left this exact shape after a failed rename and released its lock.
  writeFileSync(join(h.local, `state.json.create-reappeared-${"ab".repeat(16)}.tmp`), "{\"partial");
  const before = h.saved();
  await assert.rejects(h.task({ run }).collect(), /observed again/);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0); assert.equal(h.saved().createErrored.evidenceSha256, before.createErrored.evidenceSha256);
  const next = harness(t, { stateRoot: h.base, round: "r22" });
  await assert.rejects(next.launch().launch(), /observed again/); assert.equal(next.creates, 0);
});

test("a contradiction whose publication fails keeps the operation lock, and the receipt never resolves after the custody step", async (t) => {
  for (const failure of ["rename", "stage write", "every write"]) {
    const { h, run, task } = erroredLaunch(t);
    await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
    const original = readFileSync(h.statePath);
    h.hosts([{ ...h.host(), name: "renamed-by-someone", tags: [] }]);
    const createReappearedIo = {
      durable(path, bytes) {
        const stage = path.includes("state.json.create-reappeared-");
        if (failure === "every write" || failure === "stage write" && stage) throw eio();
        return durable(path, bytes);
      },
      rename() { throw eio(); },
    };
    await assert.rejects(h.task({ run, createReappearedIo }).collect(), (error) => {
      assert.equal(error.controllerStage, "create-contradiction-unpublished", failure);
      assert.match(publicError(error), /provider-create-reappeared/); return true;
    });
    assert.ok(readFileSync(h.statePath).equals(original), `${failure}: the old state is not replaced`);
    assert.ok(existsSync(join(h.local, "operation.lock")), `${failure}: custody is kept`);
    assert.equal(existsSync(join(h.local, "provider-create-reappeared")), failure !== "every write");
    let calls = h.calls.length;
    await assert.rejects(h.task({ run }).collect(), /still holds custody/); assert.equal(h.calls.length, calls);
    // The custody step for that lock. When nothing was written, it records the witness first.
    if (failure === "every write") writeFileSync(join(h.local, "provider-create-reappeared"), "");
    unlinkSync(join(h.local, "operation.lock"));
    h.hosts([]);
    await assert.rejects(h.task({ run }).collect(), /observed again/, failure);
    assert.equal(h.saved().createErrored.evidenceSha256, JSON.parse(original).createErrored.evidenceSha256);
    const next = harness(t, { stateRoot: h.base, round: "r22" });
    await assert.rejects(next.launch().launch(), /observed again/); assert.equal(next.creates, 0);
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
  }
});

// Review round 4, finding 3. A contradicted receipt beside an exact, positively owned
// droplet had no route: every collect refused and the pinned path could not admit it.
const contradictionRoutes = {
  "a published receipt whose droplet reappears": async (t) => {
    const { h, run, task } = erroredLaunch(t, { flags: { missingUnit: true } });
    await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
    h.hosts([h.host()]);
    return { h, run };
  },
  "a recorded contradiction whose droplet later shows its saved ownership": async (t) => {
    const { h, run, task } = erroredLaunch(t, { flags: { missingUnit: true } });
    await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
    h.hosts([{ ...h.host(), name: "renamed-by-someone", tags: [] }]);
    await assert.rejects(h.task({ run }).collect(), /observed again/);
    assert.equal(h.saved().createErrored.reappeared.via, "exact-get");
    h.hosts([h.host()]);
    return { h, run };
  },
  "an unpublished receipt beside a late errored action whose droplet is present": async (t) => {
    const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h);
    const state = h.saved();
    writeFileSync(join(h.local, "provider-create-errored.json"), createErroredBytes(createErroredRecord(state, state.createPending, 0, "2026-11-20T00:00:00.000Z")));
    h.hosts([h.host()]);
    return { h, run: o.run };
  },
  "an unpublished receipt beside a late completed action": async (t) => {
    const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h);
    const state = h.saved();
    writeFileSync(join(h.local, "provider-create-errored.json"), createErroredBytes(createErroredRecord(state, state.createPending, 0, "2026-11-20T00:00:00.000Z")));
    o.action = actionRow({ status: "completed" }); h.hosts([h.host()]);
    return { h, run: o.run };
  },
  // Review round 5, finding 3. A published receipt contradicted by another ID carrying
  // its saved name and tags; the exact posted droplet later shows its saved ownership.
  "a published receipt contradicted by an inventory alias whose posted droplet then shows its ownership": async (t) => {
    const { h, run, task } = erroredLaunch(t, { flags: { missingUnit: true } });
    await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
    h.hosts([{ ...h.host(), id: 999 }]);
    await assert.rejects(h.task({ run }).collect(), /observed again/);
    assert.deepEqual([h.saved().createErrored.reappeared.via, h.saved().createErrored.reappeared.dropletId], ["inventory", "999"]);
    h.hosts([h.host()]);
    return { h, run, witnessed: "999" };
  },
  // Review round 5, findings 2 and 3, unpublished: the census alias is recorded, then the exact droplet binds.
  "an unpublished receipt contradicted by an inventory alias whose posted droplet then shows its ownership": async (t) => {
    const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h);
    const state = h.saved();
    writeFileSync(join(h.local, "provider-create-errored.json"), createErroredBytes(createErroredRecord(state, state.createPending, 0, "2026-11-20T00:00:00.000Z")));
    h.hosts([{ ...h.host(), id: 999 }]);
    await assert.rejects(o.collect(), (error) => error.controllerStage === "create-errored-contradicted");
    assert.equal(h.saved().id, undefined);
    h.hosts([h.host()]);
    return { h, run: o.run, witnessed: "999" };
  },
};
for (const [name, setup] of Object.entries(contradictionRoutes)) {
  test(`${name} binds only that exact owned droplet, keeps the evidence, and retires only by the pinned unused route`, async (t) => {
    const { h, run, witnessed = "123" } = await setup(t);
    const receipt = readFileSync(join(h.local, "provider-create-errored.json"));
    assert.equal(await h.task({ run }).collect(), 3);
    const bound = h.saved();
    assert.equal(bound.status, "preparing"); assert.equal(bound.id, "123"); assert.equal(bound.ip, "192.0.2.10");
    assert.equal(bound.createErrored, undefined);
    assert.deepEqual({ dropletId: bound.createContradicted.dropletId, actionId: bound.createContradicted.actionId, evidenceSha256: bound.createContradicted.evidenceSha256 },
      { dropletId: "123", actionId: "456", evidenceSha256: digest(receipt) });
    assert.equal(bound.createContradicted.reappeared.dropletId, "123");
    assert.equal(bound.createContradicted.receiptVerified, true, "a canonical receipt is verified evidence");
    assert.ok(readFileSync(join(h.local, "provider-create-errored.json")).equals(receipt), "the receipt is kept as evidence");
    assert.ok(existsSync(join(h.local, "provider-create-reappeared")), "the contradiction witness is kept");
    // The first observation stays in the witness, bound by hash; the bind's exact read is recorded beside it.
    const witness = readFileSync(join(h.local, "provider-create-reappeared"));
    assert.equal(JSON.parse(witness).dropletId, witnessed); assert.equal(bound.createContradicted.witnessSha256, digest(witness));
    assert.ok(!existsSync(join(h.local, "operation.lock")));
    assert.ok(!h.calls.some(([binary, ...args]) => binary === "ssh" || binary === "scp" || binary === "doctl" && args[2] === "delete"));
    // The receipt is never accepted again: a later round still waits for this reservation.
    const next = harness(t, { stateRoot: h.base, round: "r22" });
    await assert.rejects(next.launch().launch(), /unresolved reservation/); assert.equal(next.creates, 0);
    await assert.rejects(h.task({ run }).collect(), /approved pinned observation/); assert.equal(h.deletes, 0);
    assert.equal(await h.pinnedUnused({ run }).collect(), 1);
    const retired = h.saved();
    assert.equal(retired.retirement.kind, "unused"); assert.ok(retired.destroyedAt); assert.deepEqual(retired.createContradicted, bound.createContradicted);
    assert.equal(h.deletes, 1); assert.equal(h.creates, 1);
    assert.equal(h.calls.filter(([binary, ...args]) => binary === "ssh" && args.at(-1).includes("benchmark-unused-host/v1")).length, 1);
  });
}

test("a contradicted receipt binds nothing that is not exactly and positively owned", async (t) => {
  const cases = {
    absent: () => [],
    renamed: (h) => [{ ...h.host(), name: "renamed-by-someone", tags: [] }],
    "another region": (h) => [{ ...h.host(), region: { slug: "nyc1" } }],
    "no public address": (h) => [{ ...h.host(), networks: { v4: [] } }],
    "two public addresses": (h) => [{ ...h.host(), networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }, { type: "public", ip_address: "192.0.2.11" }] } }],
    "another ID with its name and tags": (h) => [{ ...h.host(), id: 999 }],
    // Review round 5, finding 1. Substrings of a string are not ownership tags.
    "tags as one string of lookalikes": (h) => [{ ...h.host(), tags: h.host().tags.map((tag) => `lookalike-${tag}`).join(",") }],
    "a non-string tag beside the ownership tags": (h) => [{ ...h.host(), tags: [...h.host().tags, 7] }],
  };
  for (const [name, hosts] of Object.entries(cases)) {
    const { h, run, task } = erroredLaunch(t);
    await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
    writeFileSync(join(h.local, "provider-create-reappeared"), "");
    h.hosts(hosts(h));
    const before = h.calls.length;
    await assert.rejects(h.task({ run }).collect(), (error) => {
      assert.match(error.message, /observed again/, name); assert.equal(error.controllerStage, "create-errored-contradicted", name);
      assert.match(publicError(error), /--unused-bootstrap-known-hosts/); return true;
    });
    const state = h.saved();
    assert.equal(state.id, undefined, name); assert.equal(state.status, "creating"); assert.equal(state.createContradicted, undefined);
    // Only the exact GET of the posted ID, never a census.
    assert.deepEqual(h.calls.slice(before).map(([, ...args]) => args[0] === "account" ? "account" : args[2]), ["account", "get", "account"], name);
    assert.equal(h.deletes, 0); assert.equal(h.creates, 1);
    assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
  }
});

// Review round 5, finding 1. The fresh ownership check before a DELETE accepted a string of lookalikes.
test("a bound contradicted droplet whose tags then arrive malformed is never deleted", async (t) => {
  const { h, run } = await contradictionRoutes["a published receipt whose droplet reappears"](t);
  assert.equal(await h.task({ run }).collect(), 3);
  const bound = h.saved();
  h.hosts([{ ...h.host(), tags: h.host().tags.map((tag) => `lookalike-${tag}`).join(",") }]);
  await assert.rejects(h.pinnedUnused({ run }).collect(), /ownership tag/);
  assert.equal(h.deletes, 0); assert.deepEqual(h.saved(), bound, "no retirement record or deletion intent");
  assert.ok(!existsSync(join(h.local, "operation.lock")));
  h.hosts([h.host()]);
  assert.equal(await h.pinnedUnused({ run }).collect(), 1); assert.equal(h.deletes, 1);
});

// Review round 5, finding 2 and the benchmark lane's census case. The previous controller
// refused the first collect without a witness, then adopted the receipt on the second.
const notFound = () => ({ status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 404 } });
test("an unpublished receipt whose posted ID the census lists after an exact 404 is contradicted for good", async (t) => {
  const { h, o, task } = lateLaunch(t);
  await assert.rejects(task.launch(), { controlUncertain: true });
  release(h);
  const state = h.saved(), receipt = join(h.local, "provider-create-errored.json");
  const bytes = createErroredBytes(createErroredRecord(state, state.createPending, 0, "2026-11-20T00:00:00.000Z"));
  writeFileSync(receipt, bytes);
  // The exact GET is 404 while the single-response census lists the posted ID, renamed and untagged.
  o.get = notFound; h.hosts([{ ...h.host(), name: "renamed-by-someone", tags: [] }]);
  let before = h.calls.length;
  await assert.rejects(o.collect(), (error) => {
    assert.equal(error.controllerStage, "create-errored-contradicted"); assert.match(error.message, /observed again/); return true;
  });
  assert.deepEqual(o.after(before), ["account", "action", "account", "account", "get", "account", "account", "list", "account"]);
  const witness = JSON.parse(readFileSync(join(h.local, "provider-create-reappeared")));
  assert.deepEqual([witness.via, witness.dropletId], ["inventory", "123"]);
  assert.deepEqual(h.saved(), state, "nothing is bound or published");
  assert.ok(!existsSync(join(h.local, "operation.lock")), "the contradiction is recorded, not retained custody");
  // Gone again: a fresh exact 404 cannot adopt the contradicted receipt, and no census is read.
  h.hosts([]);
  before = h.calls.length;
  await assert.rejects(o.collect(), (error) => error.controllerStage === "create-errored-contradicted");
  assert.deepEqual(o.after(before), ["account", "action", "account", "account", "get", "account"]);
  assert.deepEqual(h.saved(), state, "the receipt is never adopted; no create intent is recorded");
  assert.equal(readFileSync(receipt, "utf8"), bytes);
  // No create intent or POST, here or in a later round in this root.
  const next = harness(t, { stateRoot: h.base, round: "r22" });
  await assert.rejects(next.launch().launch());
  assert.equal(next.creates, 0); assert.ok(!next.calls.some(([binary, ...args]) => binary === "doctl" && args[2] === "create"));
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
  assert.ok(!h.calls.some(([binary, ...args]) => binary === "ssh" || binary === "scp" || binary === "doctl" && args[2] === "delete"));
});

// Review round 5, finding 4. A stage left by a failed contradiction rename stranded the bound host.
test("a stage left by a failed contradiction rename is recorded at the bind and admitted at retirement only with its bytes", async (t) => {
  const { h, run, task } = erroredLaunch(t, { flags: { missingUnit: true } });
  await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
  h.hosts([{ ...h.host(), name: "renamed-by-someone", tags: [] }]);
  await assert.rejects(h.task({ run, createReappearedIo: { durable, rename() { throw eio(); } } }).collect(),
    (error) => error.controllerStage === "create-contradiction-unpublished");
  const [stage] = reappearedStage(h);
  assert.ok(stage, "the failed rename left its stage");
  unlinkSync(join(h.local, "operation.lock")); // The custody step for that collect.
  h.hosts([h.host()]);
  assert.equal(await h.task({ run }).collect(), 3);
  const bound = h.saved(), path = join(h.local, stage), bytes = readFileSync(path);
  assert.deepEqual(bound.createContradicted.stages, [{ name: stage, sha256: digest(bytes) }]);
  // Changed bytes or an unrecorded stage are not admitted.
  writeFileSync(path, "changed");
  await assert.rejects(h.pinnedUnused({ run }).collect(), /stage changed/); assert.equal(h.deletes, 0);
  writeFileSync(path, bytes);
  const stray = join(h.local, `state.json.create-reappeared-${"cd".repeat(16)}.tmp`);
  writeFileSync(stray, "{}");
  await assert.rejects(h.pinnedUnused({ run }).collect(), /unexpected local bootstrap custody/); assert.equal(h.deletes, 0);
  unlinkSync(stray);
  assert.equal(await h.pinnedUnused({ run }).collect(), 1);
  assert.equal(h.deletes, 1); assert.ok(readFileSync(path).equals(bytes), "the stage is kept as evidence");
});

// Review round 5, finding 5. Arbitrary bytes were recorded as this attempt's verified receipt.
test("an unpublished receipt that is not the canonical record is kept only as an unverified artifact", async (t) => {
  for (const kind of ["canonical", "truncated"]) {
    const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h);
    const state = h.saved();
    const bytes = kind === "canonical" ? createErroredBytes(createErroredRecord(state, state.createPending, 0, "2026-11-20T00:00:00.000Z")) : "{truncated";
    writeFileSync(join(h.local, "provider-create-errored.json"), bytes);
    h.hosts([h.host()]);
    assert.equal(await o.collect(), 3, kind);
    const c = h.saved().createContradicted;
    assert.equal(c.receiptVerified, kind === "canonical", kind); assert.equal(c.evidenceSha256, digest(bytes), kind);
    assert.equal(await h.pinnedUnused({ run: o.run }).collect(), 1, kind); assert.equal(h.deletes, 1);
  }
});

// Review round 4, finding 4. The CLI prints only allowlisted stages; the route must be one.
test("the public error names the supported route for an offline never-started or contradicted reservation", () => {
  for (const stage of ["offline-never-started", "create-errored-contradicted"])
    assert.match(publicError({ controllerStage: stage }), /--collect --unused-bootstrap-known-hosts/, stage);
  assert.match(publicError({ controllerStage: "create-contradiction-unpublished" }), /provider-create-reappeared/);
  assert.doesNotMatch(publicError(new Error("--collect --unused-bootstrap-known-hosts")), /unused-bootstrap/);
});

// Review round 6, finding 1. Two posted-create paths bound a droplet from the census: a late
// completed action with no receipt (no exact GET at all), and an in-deadline errored create
// after its exact GET was 404 or failed. Only a positive exact GET of the posted ID binds.
test("a late completed action binds nothing when its exact GET is not a positive owned read, whatever the census lists", async (t) => {
  for (const kind of ["404", "503", "renamed"]) {
    const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
    await assert.rejects(task.launch(), { controlUncertain: true });
    release(h);
    o.action = actionRow({ status: "completed" });
    // The census lists the owned posted droplet in every case.
    h.hosts([h.host()]);
    if (kind === "404") o.get = notFound;
    else if (kind === "503") o.get = () => ({ status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 503 } });
    else o.get = () => ({ status: 0, stdout: JSON.stringify([{ ...h.host(), name: "renamed-by-someone", tags: [] }]), stderr: "" });
    const before = h.calls.length;
    await assert.rejects(o.collect(), /nothing bound/, kind);
    assert.deepEqual(o.after(before), ["account", "action", "account", "account", "get", "account"], kind);
    preserved(h);
  }
});

test("an in-deadline errored create binds only its posted droplet's positive exact GET, never the census", async (t) => {
  const failures = {
    "exact 404 with the owned posted droplet listed": notFound,
    "exact 503 with the owned posted droplet listed": () => ({ status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 503 } }),
  };
  for (const [name, get] of Object.entries(failures)) {
    const { h, task } = erroredLaunch(t, { hosts: (h) => [h.host()], get });
    await assert.rejects(task.launch(), (error) => {
      assert.notEqual(error.providerDiagnostic?.code, "create-errored-absent", name);
      assert.match(error.message, /without binding/, name); return true;
    });
    const state = h.saved();
    assert.equal(state.id, undefined, name); assert.equal(state.ip, undefined, name); assert.equal(state.status, "creating", name);
    assert.deepEqual(state.createPending, { dropletId: "123", actionId: "456" }, name); assert.equal(state.createErrored, undefined, name);
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
    assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"), name);
  }
  // The positive: the exact GET returns the owned posted droplet, which binds with no census read.
  const { h, task } = erroredLaunch(t, { hosts: (h) => [h.host()] });
  await assert.rejects(task.launch(), /create completion was not proved/);
  const calls = providerCalls(h);
  assert.deepEqual(calls.slice(calls.indexOf("create") + 1), ["account", "account", "get", "account"]);
  assert.equal(h.saved().id, "123"); assert.equal(h.deletes, 0);
  assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"));
});

// Review round 6, finding 2. A receipt written and a create-errored publication stage left by an
// interrupted rename: the bind of the reappeared droplet succeeded, then the pinned retirement
// refused the stage as unexpected custody, stranding the bound host.
const erroredStage = (h, nonce = "ef".repeat(16)) => join(h.local, `state.json.create-errored-${nonce}.tmp`);
async function interruptedPublication(t, stageBytes) {
  const { h, o, task } = lateLaunch(t, { flags: { missingUnit: true } });
  await assert.rejects(task.launch(), { controlUncertain: true });
  release(h);
  const state = h.saved(), receipt = createErroredBytes(createErroredRecord(state, state.createPending, 0, "2026-11-20T00:00:00.000Z"));
  writeFileSync(join(h.local, "provider-create-errored.json"), receipt);
  // The bytes publishCreateErrored stages for this state before its rename.
  const publication = `${JSON.stringify({ ...state, createErrored: { ...state.createPending, evidenceSha256: digest(receipt) } }, null, 2)}\n`;
  const stage = erroredStage(h);
  writeFileSync(stage, stageBytes(publication));
  h.hosts([h.host()]);
  return { h, o, stage };
}
test("an interrupted receipt publication's stage is recorded at the bind and admitted at retirement only with its bytes", async (t) => {
  for (const kind of ["complete", "partial write"]) {
    const { h, o, stage } = await interruptedPublication(t, (bytes) => kind === "complete" ? bytes : bytes.slice(0, 40));
    const bytes = readFileSync(stage);
    assert.equal(await o.collect(), 3, kind);
    const bound = h.saved();
    assert.equal(bound.id, "123"); assert.deepEqual(bound.createContradicted.stages, [{ name: basename(stage), sha256: digest(bytes) }], kind);
    // Changed bytes or an unrecorded stage are not admitted.
    writeFileSync(stage, "changed");
    await assert.rejects(h.pinnedUnused({ run: o.run }).collect(), /stage changed/, kind); assert.equal(h.deletes, 0);
    writeFileSync(stage, bytes);
    const stray = erroredStage(h, "cd".repeat(16));
    writeFileSync(stray, bytes);
    await assert.rejects(h.pinnedUnused({ run: o.run }).collect(), /unexpected local bootstrap custody/, kind); assert.equal(h.deletes, 0);
    unlinkSync(stray);
    assert.equal(await h.pinnedUnused({ run: o.run }).collect(), 1, kind);
    assert.equal(h.deletes, 1); assert.ok(readFileSync(stage).equals(bytes), "the stage is kept as evidence");
  }
});
test("a create-errored stage that is not this reservation's publication binds nothing", async (t) => {
  for (const [kind, change] of Object.entries({ "other bytes": () => "{}\n", "another state": (bytes) => bytes.replace('"creating"', '"preparing"') })) {
    const { h, o, stage } = await interruptedPublication(t, change);
    const before = h.saved(), bytes = readFileSync(stage);
    await assert.rejects(o.collect(), /not this reservation's publication/, kind);
    assert.deepEqual(h.saved(), before, kind); assert.ok(readFileSync(stage).equals(bytes), kind);
    assert.ok(existsSync(join(h.local, "provider-create-reappeared")), "the contradiction is still recorded");
    assert.equal(h.deletes, 0);
    assert.ok(!h.calls.some(([binary]) => binary === "ssh" || binary === "scp"), kind);
  }
});

// Review round 6, finding 3, for an earlier round in the same root: a contradiction recorded
// after the launch's census and before its create still blocks the create intent and POST.
test("a later launch sends no create when an earlier round's contradiction is recorded after its census", async (t) => {
  for (const late of [true, false]) {
    const { h, task } = erroredLaunch(t);
    await assert.rejects(task.launch(), { providerDiagnostic: { code: "create-errored-absent" } });
    const next = harness(t, { stateRoot: h.base, round: "r22", hostId: "999", createReturnedId: 999, active: true });
    const run = (binary, args, ...rest) => {
      const result = next.run(binary, args, ...rest);
      if (late && binary === "doctl" && args[2] === "list") writeFileSync(join(h.local, "provider-create-reappeared"), "");
      return result;
    };
    if (late) {
      await assert.rejects(next.launch({ run }).launch(), /changed before this create/);
      assert.equal(next.creates, 0); assert.ok(!providerCalls(next).includes("create"));
      assert.equal(next.saved().createIntentAt, undefined);
    } else { await next.launch({ run }).launch(); assert.equal(next.creates, 1); }
  }
});

// Review round 6, finding 4, for the same root: a contradicted attempt retired by the pinned
// route still fences its posted ID, as the runbook says.
test("a later launch in the same root still fences a contradicted posted ID after its verified retirement", async (t) => {
  for (const listed of [true, false]) {
    const { h, run } = await contradictionRoutes["a published receipt whose droplet reappears"](t);
    assert.equal(await h.task({ run }).collect(), 3);
    assert.equal(await h.pinnedUnused({ run }).collect(), 1);
    assert.ok(h.saved().destroyedAt);
    const next = harness(t, { stateRoot: h.base, round: "r22", hostId: "999", createReturnedId: 999, active: true });
    if (listed) {
      next.hosts([{ ...h.host(), name: "renamed-by-someone", tags: [] }]);
      await assert.rejects(next.launch().launch(), /posted droplet is listed/);
      assert.equal(next.creates, 0); assert.equal(next.saved().createIntentAt, undefined);
    } else { await next.launch().launch(); assert.equal(next.creates, 1); }
  }
});
