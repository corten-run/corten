// Permanent P1 regressions. All credentials, accounts and host identities below
// are unmistakably synthetic. Native child processes run no provider/network API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { accountId, commit, context, harness } from "./cloud-fixtures.mjs";
import { productionMain } from "./cloud-production.mjs";
import { createProviderEngine } from "./cloud-engine-test-fixture.mjs";

function nativeHarness(t, attack = null) {
  const h = harness(t, { active: true }), configPath = join(h.temp, "synthetic-config.yaml"), ledgerPath = join(h.temp, "synthetic-ledger.json");
  const config = (account) => ({ context, "auth-contexts": { [context]: `SYNTHETIC_ONLY_CREDENTIAL_${account}` } });
  writeFileSync(configPath, JSON.stringify(config("A")), { mode: 0o600 });
  writeFileSync(ledgerPath, JSON.stringify({ hosts: { A: [], B: [] }, mutations: [], calls: [], restoreOriginal: attack !== null }));
  let rebound = false, approval;
  const spawn = (binary, argv, options) => {
    if (binary === "git" && argv[0] === "show") return { status: 0, stdout: readFileSync(resolve(argv[1].slice(41)), "utf8").replaceAll("\r\n", "\n") };
    if (binary === "doctl") {
      assert.deepEqual(argv.slice(0, 2), ["auth", "token"], "only credential consumption may run doctl");
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("cloud-credentials-fixture.mjs", import.meta.url)), configPath, ledgerPath, h.statePath, ...argv],
        { ...options, env: {}, timeout: 5000 });
      return result;
    }
    const args = [...argv];
    if (binary === "ssh") args[args.length - 1] = options.input.replace(/^set -euo pipefail\n/, "").replace(/\n$/, "");
    return h.run(binary, args, options.timeout);
  };
  const providerRequest = async ({ method, path, body, credential, timeout }) => {
    if (path === "/v2/actions/456") return { status: 200, value: { action: { id: 456, resource_id: 123, resource_type: "droplet", type: "create", status: "completed" } } };
    const argv = path === "/v2/account" ? ["account", "get", "--output", "json"]
      : method === "GET" ? ["compute", "droplet", "list", "--output", "json"]
        : ["compute", "droplet", "create", body.name, "--size", body.size, "--region", body.region, "--image", body.image,
          "--ssh-keys", String(body.ssh_keys[0]), "--tag-names", body.tags.join(","), "--wait", "--output", "json"];
    assert.ok(method !== "DELETE", "regressions must not delete a synthetic host");
    if (!rebound && argv[0] === "compute" && argv[2] === attack) { rebound = true; writeFileSync(configPath, JSON.stringify(config("B"))); }
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("cloud-credentials-fixture.mjs", import.meta.url)), configPath, ledgerPath, h.statePath,
      ...argv, "--context", context, "--synthetic-rest-stdin"], { env: {}, input: JSON.stringify({ credential }), encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0); const value = JSON.parse(result.stdout);
    if (path === "/v2/account") return { status: 200, value: { account: value } };
    if (method === "GET") return { status: 200, value: { droplets: value, meta: { total: value.length }, links: {} } };
    // Keep fake SSH/systemd state in sync. Only the native ledger determines
    // which account actually mutated; no credential is in the child's argv/env.
    h.run("doctl", [...argv, "--context", context], timeout);
    return { status: 202, value: { droplet: value[0], links: { actions: [{ id: 456, rel: "create", href: "https://api.digitalocean.com/v2/actions/456" }] } } };
  };
  const deps = { spawn, providerRequest, repo: h.repo, inspect: async () => h.report(), sleep: async () => {}, write(value) { approval = JSON.parse(value).approvalSha256; } };
  deps.providerFactory = ({ repo, interrupted }) => Object.assign(createProviderEngine({ repo, interrupted, spawn, request: providerRequest, sleep: deps.sleep }), { close: async () => {} });
  const args = (detach) => ["r21", "--state-dir", h.base, ...(detach ? ["--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context] : ["--collect"])];
  async function action(detach = false) {
    const values = args(detach); await productionMain([...values, "--print-approval"], deps);
    return productionMain([...values, "--approve-reviewed-merged-ready", approval], deps);
  }
  return { h, action, configPath, ledgerPath, config, ledger: () => JSON.parse(readFileSync(ledgerPath)), get rebound() { return rebound; } };
}

function assertMatchingProbes(p, command) {
  const calls = p.ledger().calls;
  assert.ok(calls.filter(({ command }) => command === "account").every(({ account }) => account === "A"));
  const foreign = calls.findIndex((call) => call.command === command && call.account === "B");
  if (foreign !== -1) assert.deepEqual(calls.slice(foreign - 1, foreign + 2), [
    { command: "account", account: "A" }, { command, account: "B" }, { command: "account", account: "A" },
  ], "synthetic rebind-restore was bracketed by matching account probes");
}

test("native saved-context ordinary positive mutates only its approved synthetic account", { timeout: 60000 }, async (t) => {
  const p = nativeHarness(t); assert.equal(await p.action(true), 3);
  assert.equal(p.ledger().hosts.A.length, 1); assert.equal(p.ledger().hosts.B.length, 0);
  assert.deepEqual(p.ledger().mutations, [{ operation: "create", account: "A" }]);
  assert.equal(p.ledger().calls.filter(({ command }) => command === "consume").length, 1);
});

test("native saved-context initial mismatch refuses before any synthetic mutation", { timeout: 15000 }, async (t) => {
  const p = nativeHarness(t); writeFileSync(p.configPath, JSON.stringify(p.config("B")));
  await assert.rejects(p.action(true), /account identity/); assert.deepEqual(p.ledger().mutations, []);
});

test("native rebind-restore cannot mutate a foreign account between matching account probes", { timeout: 60000 }, async (t) => {
  const p = nativeHarness(t, "create");
  await p.action(true).catch(() => {}); // Refusal is safe only if no foreign mutation already happened.
  assert.equal(p.rebound, true);
  assert.equal(p.ledger().calls.filter(({ command }) => command === "consume").length, 1);
  assertMatchingProbes(p, "create");
  assert.deepEqual(JSON.parse(readFileSync(p.configPath)), p.config("A"));
  assert.equal(p.ledger().hosts.B.length, 0, "P1: native CLI used rebound credentials to create a foreign host");
});

test("native rebind-restore empty foreign list cannot confirm the original host destroyed", { timeout: 15000 }, async (t) => {
  const p = nativeHarness(t, "list"); p.h.seed(); p.h.flags.active = false; p.h.flags.deleteUnconfirmed = true;
  await assert.rejects(p.h.task().collect(), /deletion not confirmed/);
  const state = p.h.saved(), ledger = p.ledger();
  ledger.hosts.A = [{ id: 123, name: state.name, tags: ["corten-bench", "corten-bench-groups", state.tag], size_slug: state.host.size,
    region: { slug: state.host.region }, networks: { v4: [{ type: "public", ip_address: state.ip }] } }];
  writeFileSync(p.ledgerPath, JSON.stringify(ledger));
  await p.action().catch(() => {});
  assert.equal(p.rebound, true); assert.equal(p.ledger().hosts.A.length, 1);
  assert.equal(p.ledger().calls.filter(({ command }) => command === "consume").length, 1);
  assertMatchingProbes(p, "list");
  assert.deepEqual(JSON.parse(readFileSync(p.configPath)), p.config("A"));
  assert.ok(!p.h.saved().destroyedAt, "P1: absence in rebound account falsely confirmed destruction of an existing original host");
});
