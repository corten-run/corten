// Synthetic controls for issue #1689: a create the provider accepted and then
// failed. No provider, droplet or SSH process runs here.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createProviderEngine as providerTransport } from "./cloud-engine-test-fixture.mjs";
import { context, harness } from "./cloud-fixtures.mjs";
import { digest } from "./cloud-local.mjs";
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

test("an errored action observed after the create deadline stays uncertain", async () => {
  // Pending until the original deadline: the r21 action errored 22 minutes later.
  const { run, calls } = engine(action(), { pending: 1000 });
  await assert.rejects(run(create, 2500, true), (error) => error.controlUncertain === true
    && error.providerDiagnostic?.code === "create-action-pending");
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
});

const errored = (id = 123, actionId = 456) => ({ status: 1, stdout: JSON.stringify([{ id, actionId }]), stderr: "",
  providerDiagnostic: { code: "create-action-errored" } });
const providerCalls = (h) => h.calls.filter(([binary]) => binary === "doctl").map(([, ...args]) => args[0] === "account" ? "account" : args[2]);

// Wrap the synthetic controller transport. The fake create still checks that
// intent is durable before dispatch; the provider then fails it and holds hosts.
function erroredLaunch(t, { result = errored(), hosts = [], get, account } = {}) {
  const h = harness(t); let created = false, accounts = 0;
  const run = (binary, args, ...rest) => {
    if (binary === "doctl" && args[2] === "create") {
      h.run(binary, args, ...rest); created = true; h.hosts(typeof hosts === "function" ? hosts(h) : hosts); return result;
    }
    if (binary === "doctl" && args[2] === "get" && get) { h.calls.push([binary, ...args]); return get(h, args); }
    if (binary === "doctl" && args[0] === "account" && created && account) return account(h, ++accounts) ?? h.run(binary, args, ...rest);
    return h.run(binary, args, ...rest);
  };
  return { h, task: h.launch({ run }) };
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
